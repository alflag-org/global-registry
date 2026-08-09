import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../../src/api/app';

const origin = 'http://localhost';
const adminIdentity = 'access:http-admin';
const readonlyIdentity = 'access:http-readonly';
const inactiveIdentity = 'access:http-inactive';
const unmappedIdentity = 'access:http-unmapped';

function requestHeaders(
  identity: string,
  options: { json?: boolean; origin?: string; secFetchSite?: string } = {},
): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    host: 'localhost',
    'x-global-registry-dev-secret': env.LOCAL_AUTH_SECRET,
    'x-global-registry-dev-identity': identity,
  });
  if (options.json === true) headers.set('content-type', 'application/json');
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.secFetchSite !== undefined) {
    headers.set('sec-fetch-site', options.secFetchSite);
  }
  return headers;
}

async function fetchAs(
  identity: string,
  path: string,
  init: Omit<RequestInit, 'headers'> & {
    headers?: { origin?: string; secFetchSite?: string };
  } = {},
): Promise<Response> {
  const { headers: extraHeaders, ...requestInit } = init;
  return SELF.fetch(
    new Request(`${origin}${path}`, {
      ...requestInit,
      headers: requestHeaders(identity, {
        json: requestInit.body !== undefined,
        ...(extraHeaders?.origin === undefined ? {} : { origin: extraHeaders.origin }),
        ...(extraHeaders?.secFetchSite === undefined
          ? {}
          : { secFetchSite: extraHeaders.secFetchSite }),
      }),
    }),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code;
}

describe.sequential('Access principal and Actor HTTP boundaries', () => {
  beforeAll(async () => {
    const timestamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-http-admin',
        adminIdentity,
        'HTTP Admin',
        timestamp,
        timestamp,
        'actor-http-admin',
        'actor-http-admin',
      ),
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, 'readonly', 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-http-readonly',
        readonlyIdentity,
        'HTTP Readonly',
        timestamp,
        timestamp,
        'actor-http-admin',
        'actor-http-admin',
      ),
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, 'readonly', 0, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-http-inactive',
        inactiveIdentity,
        'HTTP Inactive',
        timestamp,
        timestamp,
        'actor-http-admin',
        'actor-http-admin',
      ),
    ]);
  });

  it('returns mapped and unmapped sessions without exposing registry state', async () => {
    const mapped = await fetchAs(adminIdentity, '/api/v1/auth/session');
    expect(mapped.status).toBe(200);
    expect(await mapped.json()).toMatchObject({
      identity: adminIdentity,
      principalType: 'human',
      mapped: true,
      actor: {
        id: 'actor-http-admin',
        displayName: 'HTTP Admin',
        role: 'admin',
        active: true,
        revision: 1,
      },
    });

    const unmapped = await fetchAs(unmappedIdentity, '/api/v1/auth/session');
    expect(unmapped.status).toBe(200);
    expect(await unmapped.json()).toEqual({
      identity: unmappedIdentity,
      principalType: 'human',
      mapped: false,
      actor: null,
    });
  });

  it('rejects unmapped and inactive principals from registry APIs', async () => {
    const unmapped = await fetchAs(unmappedIdentity, '/api/v1/resources');
    expect(unmapped.status).toBe(403);
    expect(await errorCode(unmapped)).toBe('actor_not_registered');

    const inactive = await fetchAs(inactiveIdentity, '/api/v1/auth/session');
    expect(inactive.status).toBe(403);
    expect(await errorCode(inactive)).toBe('actor_inactive');
  });

  it('redirects an unmapped browser to a page containing only its own identity', async () => {
    const redirect = await fetchAs(unmappedIdentity, '/ui', { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/ui/access-required');

    const page = await fetchAs(unmappedIdentity, '/ui/access-required');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(unmappedIdentity);
    expect(html).toContain('Identityをコピー');
    expect(html).not.toContain(adminIdentity);
    expect(html).not.toContain('HTTP Admin');
    expect(html).not.toContain('リソース');
    expect(html).not.toContain('監査ログ');
  });

  it('serves CSP-compatible UI assets only after Access authentication', async () => {
    const unauthenticated = await SELF.fetch(new Request(`${origin}/ui/assets/app.js`));
    expect([401, 503]).toContain(unauthenticated.status);

    const inactive = await fetchAs(inactiveIdentity, '/ui/assets/app.js');
    expect(inactive.status).toBe(403);
    expect(await errorCode(inactive)).toBe('actor_inactive');

    const unmappedStylesheet = await fetchAs(unmappedIdentity, '/ui/assets/app.css');
    expect(unmappedStylesheet.status).toBe(200);
    expect(unmappedStylesheet.headers.get('content-type')).toContain('text/css');
    expect(unmappedStylesheet.headers.get('cache-control')).toBe('no-store');
    expect(unmappedStylesheet.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await unmappedStylesheet.text()).toContain('.shell');

    const adminScript = await fetchAs(adminIdentity, '/ui/assets/app.js');
    expect(adminScript.status).toBe(200);
    expect(adminScript.headers.get('content-type')).toContain('application/javascript');
    expect(adminScript.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await adminScript.text()).toContain('GlobalRegistryUi');
  });

  it('enforces administrator authorization in both the API and UI', async () => {
    const api = await fetchAs(readonlyIdentity, '/api/v1/actors');
    expect(api.status).toBe(403);
    expect(await errorCode(api)).toBe('forbidden');

    const directUi = await fetchAs(readonlyIdentity, '/ui/access');
    expect(directUi.status).toBe(403);
    expect(await errorCode(directUi)).toBe('forbidden');

    const ordinaryUi = await fetchAs(readonlyIdentity, '/ui');
    expect(ordinaryUi.status).toBe(200);
    const ordinaryHtml = await ordinaryUi.text();
    expect(ordinaryHtml).not.toContain('href="/ui/access"');
    expect(ordinaryHtml).toContain('/ui/assets/app.css');
    expect(ordinaryHtml).toContain('/ui/assets/app.js');
    expect(ordinaryHtml).not.toContain('<style');
    expect(ordinaryHtml).not.toContain('<script type="module">');
  });

  it('rejects cross-site mutations and permits same-origin browser mutations', async () => {
    const payload = JSON.stringify({
      identity: 'service:http-browser-created',
      displayName: 'HTTP Browser Created',
      role: 'readonly',
    });
    const foreignOrigin = await fetchAs(adminIdentity, '/api/v1/actors', {
      method: 'POST',
      body: payload,
      headers: { origin: 'https://attacker.test' },
    });
    expect(foreignOrigin.status).toBe(403);
    expect(await errorCode(foreignOrigin)).toBe('cross_site_mutation');

    const crossSite = await fetchAs(adminIdentity, '/api/v1/actors', {
      method: 'POST',
      body: payload,
      headers: { origin, secFetchSite: 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect(await errorCode(crossSite)).toBe('cross_site_mutation');

    const sameOrigin = await fetchAs(adminIdentity, '/api/v1/actors', {
      method: 'POST',
      body: payload,
      headers: { origin, secFetchSite: 'same-origin' },
    });
    expect(sameOrigin.status).toBe(201);
    expect(await sameOrigin.json()).toMatchObject({
      identity: 'service:http-browser-created',
      principalType: 'service',
    });
  });

  it('does not require Origin from a machine client', async () => {
    const response = await fetchAs(adminIdentity, '/api/v1/actors', {
      method: 'POST',
      body: JSON.stringify({
        identity: 'service:http-machine-created',
        displayName: 'HTTP Machine Created',
        role: 'readonly',
      }),
    });
    expect(response.status).toBe(201);
  });

  it('protects and serves the generated contract and Swagger UI', async () => {
    for (const path of ['/openapi.json', '/docs']) {
      const denied = await fetchAs(unmappedIdentity, path);
      expect(denied.status).toBe(403);
      expect(await errorCode(denied)).toBe('actor_not_registered');
    }

    const documentResponse = await fetchAs(adminIdentity, '/openapi.json');
    expect(documentResponse.status).toBe(200);
    expect(await documentResponse.json()).toEqual(createOpenApiDocument());

    const docs = await fetchAs(adminIdentity, '/docs');
    expect(docs.status).toBe(200);
    const html = await docs.text();
    expect(docs.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(docs.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(docs.headers.get('content-security-policy')).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('/docs/assets/api-docs.js');
    expect(html).toContain('/openapi.json');

    const stylesheet = await fetchAs(adminIdentity, '/docs/assets/api-docs.css');
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-type')).toContain('text/css');

    const script = await fetchAs(adminIdentity, '/docs/assets/api-docs.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('application/javascript');
    expect(await script.text()).toContain('fetch(configuration.url,');
  });

  it('returns the stable JSON-limit error for deeply nested request bodies', async () => {
    const body = `${'{"displayName":"deep","identity":"service:deep","role":"readonly","nested":'.repeat(1)}${'{"next":'.repeat(5_000)}null${'}'.repeat(5_000)}}`;
    const response = await fetchAs(adminIdentity, '/api/v1/actors', {
      method: 'POST',
      body,
    });

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('json_limits_exceeded');
  });
});
