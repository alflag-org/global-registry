import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it, expect } from 'vitest';
import { app } from '../src/api/app';
import { fakeAccessContext, humanIdentity } from './access-context';

it('rejects missing runtime Access even when authentication headers are supplied', async () => {
  for (const path of [
    '/',
    '/locations',
    '/api/v1/locations',
    '/docs',
    '/openapi.json',
    '/assets/app.js',
    '/assets/app.css',
    '/assets/swagger-ui.js',
    '/assets/swagger-ui.css',
    '/assets/swagger-init.js',
    '/missing',
  ]) {
    for (const headers of [
      {},
      {
        'Cf-Access-Jwt-Assertion': 'forged',
        'CF-Access-Client-Id': 'forged',
        'CF-Access-Client-Secret': 'forged',
      },
    ]) {
      const response = await app.fetch(
        new Request('https://registry.example' + path, { headers }),
        env,
        createExecutionContext(),
      );
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'access_required' });
    }
  }
  const response = await app.fetch(
    new Request('https://registry.example/api/v1/locations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied', slug: 'denied' }),
    }),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBe(403);
  expect(await env.DB.prepare("SELECT id FROM locations WHERE slug = 'denied'").first()).toBeNull();
});

it('persists canonical human and service actors through the application audit path', async () => {
  for (const [identity, actor] of [
    [humanIdentity, 'access:' + humanIdentity.user_uuid],
    [{ service_token_status: true, service_token_id: 'machine-id' }, 'service:machine-id'],
  ] as const) {
    const context = fakeAccessContext(identity);
    const response = await app.fetch(
      new Request('https://registry.example/api/v1/locations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Audit actor', slug: crypto.randomUUID() }),
      }),
      env,
      context,
    );
    expect(response.status).toBe(201);
    const row = (await response.json()) as { id: string };
    const audit = await env.DB.prepare('SELECT actor FROM audit_log WHERE entity_id = ?')
      .bind(row.id)
      .all();
    expect(audit.results).toEqual([{ actor }]);
    for (const path of [
      '/',
      '/docs',
      '/openapi.json',
      '/api/v1/locations',
      '/assets/app.js',
      '/assets/app.css',
      '/assets/swagger-ui.js',
      '/assets/swagger-ui.css',
      '/assets/swagger-init.js',
    ]) {
      expect(
        (await app.fetch(new Request('https://registry.example' + path), env, context)).status,
      ).toBe(200);
    }
  }
});
