import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it, expect } from 'vitest';
import { authenticateAccessPrincipal } from '../src/auth/access';
import { app } from '../src/api/app';
import { fakeAccessContext, humanIdentity } from './access-context';

it('rejects missing runtime Access even when authentication headers are supplied', async () => {
  await expect(authenticateAccessPrincipal(undefined)).rejects.toMatchObject({ status: 403 });
  for (const path of [
    '/',
    '/locations',
    '/api/v1/locations',
    '/docs',
    '/openapi.json',
    '/assets/app.js',
    '/assets/app.css',
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

it('uses stable human UUIDs regardless of email and service IDs with service precedence', async () => {
  for (const email of ['before@example.invalid', 'after@example.invalid']) {
    expect(
      await authenticateAccessPrincipal(fakeAccessContext({ ...humanIdentity, email }).access),
    ).toEqual({
      identity: 'access:' + humanIdentity.user_uuid,
      type: 'human',
    });
  }
  expect(
    await authenticateAccessPrincipal(
      fakeAccessContext({
        ...humanIdentity,
        service_token_status: true,
        service_token_id: 'machine-id',
      }).access,
    ),
  ).toEqual({ identity: 'service:machine-id', type: 'service' });
});

it('rejects missing or malformed identities and identity lookup failures', async () => {
  for (const identity of [
    null,
    {},
    { email: 'only@example.invalid' },
    { user_uuid: '' },
    { user_uuid: ' padded ' },
    { user_uuid: 'bad\nvalue' },
    { user_uuid: 42 },
    { user_uuid: 'x'.repeat(256) },
    { ...humanIdentity, service_token_status: 'true' },
    { ...humanIdentity, service_token_status: true },
    { service_token_status: true, service_token_id: '' },
    { service_token_status: true, service_token_id: 42 },
  ]) {
    await expect(
      authenticateAccessPrincipal(
        fakeAccessContext(identity as CloudflareAccessIdentity | null).access,
      ),
    ).rejects.toMatchObject({ status: 403 });
  }
  await expect(
    authenticateAccessPrincipal({
      aud: 'test',
      getIdentity: async () => {
        throw new Error('unavailable');
      },
    }),
  ).rejects.toMatchObject({ status: 403 });
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
    ]) {
      expect(
        (await app.fetch(new Request('https://registry.example' + path), env, context)).status,
      ).toBe(200);
    }
  }
});
