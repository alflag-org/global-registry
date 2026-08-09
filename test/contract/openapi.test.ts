import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';

const adminHeaders = {
  host: 'localhost',
  'x-global-registry-dev-secret': env.LOCAL_AUTH_SECRET,
  'x-global-registry-dev-identity': 'access:contract-admin',
};

describe('HTTP contract', () => {
  beforeAll(async () => {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO actors (
        id, identity, display_name, role, active, revision,
        created_at, updated_at, created_by, updated_by
      )
       VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
    )
      .bind(
        'actor-contract-admin',
        'access:contract-admin',
        'Contract Admin',
        timestamp,
        timestamp,
        'actor-contract-admin',
        'actor-contract-admin',
      )
      .run();
  });

  it('does not expose a public health endpoint', async () => {
    const response = await SELF.fetch(new Request('http://localhost/healthz'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'local_auth_not_allowed' },
    });
  });

  it('renders the localized Global Registry admin shell', async () => {
    const response = await SELF.fetch(
      new Request('http://localhost/ui', { headers: adminHeaders }),
    );
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<title>Global Registry</title>');
    expect(html).toContain('Global Registry メインナビゲーション');
    expect(html).toContain('監査ログ');
  });

  it('publishes authenticated OpenAPI metadata and representative routes', async () => {
    const response = await SELF.fetch(
      new Request('http://localhost/openapi.json', { headers: adminHeaders }),
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      components: { securitySchemes: Record<string, unknown> };
      info: { title: string };
      paths: Record<string, unknown>;
      openapi: string;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Global Registry API');
    expect(document.paths['/api/v1/auth/session']).toBeDefined();
    expect(document.paths['/api/v1/operations/{id}/complete']).toBeDefined();
    expect(document.paths['/api/v1/operations/{id}/force-cancel']).toMatchObject({
      post: {
        operationId: 'forceCancelOperation',
        'x-required-roles': ['admin'],
      },
    });
    expect(document.components.securitySchemes).toMatchObject({
      CloudflareAccess: {
        type: 'apiKey',
        in: 'header',
        name: 'Cf-Access-Jwt-Assertion',
      },
    });
    expect(document.paths['/api/v1/resources/{key}']).not.toHaveProperty('delete');
    expect(document.paths['/api/v1/providers/{id}']).not.toHaveProperty('delete');
    expect(document.paths['/api/v1/actors/{id}']).not.toHaveProperty('delete');
  });

  it('does not expose hard-delete routes for actors, resources, or providers', async () => {
    for (const path of [
      '/api/v1/actors/example',
      '/api/v1/resources/example',
      '/api/v1/providers/example',
    ]) {
      const response = await SELF.fetch(
        new Request(`http://localhost${path}`, {
          method: 'DELETE',
          headers: adminHeaders,
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it('rejects list limits outside the public bounds', async () => {
    const response = await SELF.fetch(
      new Request('http://localhost/api/v1/resources?limit=101', { headers: adminHeaders }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_query' },
    });
  });

  it('rejects streamed JSON bodies after the configured size limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/v1/resources', {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'content-type': 'application/json',
      },
      body,
    });
    expect(request.headers.get('content-length')).toBeNull();

    const response = await SELF.fetch(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'request_too_large' },
    });
  });

  it('checks actual bytes when Content-Length is absent or inaccurate', async () => {
    const smallChunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    });
    const chunkedResponse = await SELF.fetch(
      new Request('http://localhost/api/v1/actors', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'application/json',
        },
        body: smallChunkedBody,
      }),
    );
    expect(chunkedResponse.headers.get('content-length')).toBeNull();
    expect(chunkedResponse.status).toBe(422);

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });
    const underestimatedResponse = await SELF.fetch(
      new Request('http://localhost/api/v1/actors', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'application/json',
          'content-length': '1',
        },
        body: oversizedBody,
      }),
    );
    expect(underestimatedResponse.status).toBe(413);

    const falselyLargeResponse = await SELF.fetch(
      new Request('http://localhost/api/v1/actors', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'application/json',
          'content-length': '1048577',
        },
        body: '{}',
      }),
    );
    expect(falselyLargeResponse.status).toBe(413);
  });

  it('requires application/json for mutation bodies', async () => {
    const response = await SELF.fetch(
      new Request('http://localhost/api/v1/actors', {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: 'unsupported_media_type' },
    });
  });

  it('returns the shared error contract for malformed JSON', async () => {
    const response = await SELF.fetch(
      new Request('http://localhost/api/v1/actors', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'application/json',
        },
        body: '{',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_json' },
      requestId: expect.any(String),
    });
  });
});
