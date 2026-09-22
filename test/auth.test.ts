import { env } from 'cloudflare:workers';
import { it, expect, vi, afterEach } from 'vitest';
import { authenticateAccessPrincipal, type AccessEnvironment } from '../src/auth/access';
import { app } from '../src/api/app';
const local: AccessEnvironment = { ...env };
function req(headers: Record<string, string> = {}, url = 'http://localhost/api/v1/locations') {
  return new Request(url, {
    headers: {
      host: new URL(url).host,
      'x-global-registry-dev-secret': local.LOCAL_AUTH_SECRET,
      ...headers,
    },
  });
}
afterEach(() => vi.restoreAllMocks());
it('permits only authenticated, unforwarded loopback development', async () => {
  expect((await authenticateAccessPrincipal(req(), local)).identity).toBe('access:local-developer');
  for (const request of [
    req({ 'x-global-registry-dev-secret': 'wrong' }),
    req({ forwarded: 'host=localhost' }),
    req({ 'cf-connecting-ip': '192.0.2.1' }),
    req({}, 'https://localhost/api/v1/locations'),
    req({}, 'http://example.com/api/v1/locations'),
  ])
    await expect(authenticateAccessPrincipal(request, local)).rejects.toThrow();
  await expect(
    authenticateAccessPrincipal(req(), { ...local, ENVIRONMENT: 'production' }),
  ).rejects.toThrow(/development/);
  await expect(
    authenticateAccessPrincipal(req(), { ...local, LOCAL_AUTH_SECRET: 'unset' }),
  ).rejects.toThrow();
});
const b64 = (data: string | Uint8Array) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
async function signer() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = crypto.randomUUID();
  const domain = crypto.randomUUID() + '.cloudflareaccess.com';
  const settings = {
    ...local,
    ENVIRONMENT: 'production',
    ALLOW_LOCAL_AUTH: 'false',
    ACCESS_TEAM_DOMAIN: domain,
    ACCESS_AUD: 'registry-audience',
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ keys: [{ ...jwk, kid, alg: 'RS256' }] }),
  );
  return {
    settings,
    async token(claims: Record<string, unknown> = {}) {
      const head = b64(JSON.stringify({ alg: 'RS256', kid }));
      const body = b64(
        JSON.stringify({
          aud: ['registry-audience'],
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: 'https://' + domain,
          sub: 'human-subject',
          ...claims,
        }),
      );
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(head + '.' + body),
      );
      return head + '.' + body + '.' + b64(new Uint8Array(signature));
    },
  };
}
it('validates production signatures and derives human and machine identities from signed claims', async () => {
  const { settings, token } = await signer();
  expect(
    (await authenticateAccessPrincipal(req({ 'Cf-Access-Jwt-Assertion': await token() }), settings))
      .identity,
  ).toBe('access:human-subject');
  expect(
    (
      await authenticateAccessPrincipal(
        req({ 'Cf-Access-Jwt-Assertion': await token({ sub: '', common_name: 'client.access' }) }),
        settings,
      )
    ).identity,
  ).toBe('service:client.access');
  const response = await app.fetch(
    req({ 'Cf-Access-Jwt-Assertion': await token({ common_name: 'client.access' }) }),
    { ...env, ...settings },
  );
  expect(response.status).toBe(200);
});
it('rejects expired, premature, wrong-audience, wrong-issuer, identity-less and forged JWTs', async () => {
  const { settings, token } = await signer();
  for (const claims of [
    { exp: 0 },
    { nbf: Math.floor(Date.now() / 1000) + 1000 },
    { aud: ['other'] },
    { iss: 'https://evil.example' },
    { sub: '', common_name: '' },
  ])
    await expect(
      authenticateAccessPrincipal(
        req({ 'Cf-Access-Jwt-Assertion': await token(claims) }),
        settings,
      ),
    ).rejects.toThrow();
  const good = await token();
  const pieces = good.split('.');
  pieces[1] = b64(
    JSON.stringify({
      aud: ['registry-audience'],
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: 'https://' + settings.ACCESS_TEAM_DOMAIN,
      sub: 'forged',
    }),
  );
  await expect(
    authenticateAccessPrincipal(req({ 'Cf-Access-Jwt-Assertion': pieces.join('.') }), settings),
  ).rejects.toThrow(/signature/);
  await expect(
    authenticateAccessPrincipal(
      req({ 'CF-Access-Client-Id': 'unverified', 'CF-Access-Client-Secret': 'unverified' }),
      settings,
    ),
  ).rejects.toThrow(/required/);
  expect((await app.fetch(req(), { ...env, ...settings })).status).toBe(401);
});

it('uses verified service identity in mutation audit and rejects production bypass configuration', async () => {
  const { settings, token } = await signer();
  const headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'Cf-Access-Jwt-Assertion': await token({ sub: '', common_name: 'automation.access' }),
  };
  const response = await app.fetch(
    new Request('http://localhost/api/v1/locations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Machine created', slug: 'machine-' + crypto.randomUUID() }),
    }),
    { ...env, ...settings },
  );
  expect(response.status).toBe(201);
  const row = (await response.json()) as { id: string };
  const audit = await env.DB.prepare('SELECT actor FROM audit_log WHERE entity_id=?')
    .bind(row.id)
    .first();
  expect(audit?.actor).toBe('service:automation.access');
  const denied = await app.fetch(req(), { ...env, ...settings, ALLOW_LOCAL_AUTH: 'true' });
  expect(denied.status).toBe(503);
});
