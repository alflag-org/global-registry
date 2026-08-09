import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authenticateAccessPrincipal,
  type AccessEnvironment,
} from '../../src/adapters/access/access';

let signingKeys: CryptoKeyPair;
let publicJwk: JsonWebKey;

function encodeBase64Url(value: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function generatedLocalSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function exampleLocalAuthSecret(): Promise<string> {
  const source = await readFile(
    fileURLToPath(new URL('../../.dev.vars.example', import.meta.url)),
    'utf8',
  );
  const line = source.split(/\r?\n/).find((entry) => entry.startsWith('LOCAL_AUTH_SECRET='));
  if (line === undefined) throw new Error('The local vars example has no LOCAL_AUTH_SECRET value.');
  return line.slice('LOCAL_AUTH_SECRET='.length);
}

function corruptJwtSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('Expected a three-segment JWT.');
  }
  const normalized = signature.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const firstByte = bytes[0];
  if (firstByte === undefined) throw new Error('Expected a non-empty JWT signature.');
  bytes[0] = firstByte ^ 1;
  return `${header}.${payload}.${encodeBase64Url(bytes)}`;
}

async function signedJwt(
  teamDomain: string,
  audience: string,
  claims: Record<string, unknown>,
  kid = 'test-key',
): Promise<string> {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', kid }));
  const now = Math.floor(Date.now() / 1000);
  const payload = encodeBase64Url(
    JSON.stringify({
      aud: [audience],
      exp: now + 300,
      iat: now,
      iss: `https://${teamDomain}`,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKeys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(signature)}`;
}

function productionEnvironment(teamDomain: string, audience: string): AccessEnvironment {
  return {
    ACCESS_AUD: audience,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ALLOW_LOCAL_AUTH: 'false',
    ENVIRONMENT: 'production',
    LOCAL_AUTH_SECRET: 'unset',
    LOCAL_ACTOR_IDENTITY: 'unset',
  };
}

function mockSigningKeys(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      keys: [
        {
          ...publicJwk,
          alg: 'RS256',
          kid: 'test-key',
          use: 'sig',
        },
      ],
    }),
  );
}

function jwksResponse(
  keys: Array<{ kid: string; jwk?: JsonWebKey }>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      keys: keys.map(({ kid, jwk = publicJwk }) => ({
        ...jwk,
        alg: 'RS256',
        kid,
        use: 'sig',
      })),
    },
    { headers },
  );
}

function streamedResponse(
  chunks: Uint8Array[],
  options: { headers?: Record<string, string>; status?: number } = {},
): { response: Response; readCount: () => number; cancelled: () => boolean } {
  let nextChunk = 0;
  let reads = 0;
  let wasCancelled = false;
  const reader = {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const value = chunks[nextChunk++];
      if (value === undefined) return { done: true, value: undefined };
      reads += 1;
      return { done: false, value };
    },
    async cancel(): Promise<void> {
      wasCancelled = true;
    },
    releaseLock(): void {},
  };
  const response = {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, readCount: () => reads, cancelled: () => wasCancelled };
}

function jwksBytes(...keys: Array<{ kid: string; jwk?: JsonWebKey }>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      keys: keys.map(({ kid, jwk = publicJwk }) => ({
        ...jwk,
        alg: 'RS256',
        kid,
        use: 'sig',
      })),
    }),
  );
}

describe('Cloudflare Access principal authentication', () => {
  beforeAll(async () => {
    signingKeys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    publicJwk = await crypto.subtle.exportKey('jwk', signingKeys.publicKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maps a valid human Access JWT to access:<sub>', async () => {
    const teamDomain = 'human-principal.cloudflareaccess.test';
    const audience = 'human-audience';
    mockSigningKeys();
    const token = await signedJwt(teamDomain, audience, {
      email: 'ignored@example.test',
      sub: 'human-subject',
    });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).resolves.toEqual({ identity: 'access:human-subject', type: 'human' });
  });

  it('uses the bounded in-isolate memo for ordinary repeated verification', async () => {
    const teamDomain = 'memoized-principal.cloudflareaccess.test';
    const audience = 'memoized-audience';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jwksResponse([{ kid: 'test-key' }]));
    const token = await signedJwt(teamDomain, audience, { sub: 'memoized-subject' });
    const environment = productionEnvironment(teamDomain, audience);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:memoized-subject', type: 'human' });
    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:memoized-subject', type: 'human' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes JWKS when a cached set does not contain the token kid', async () => {
    const teamDomain = 'unknown-kid-principal.cloudflareaccess.test';
    const audience = 'unknown-kid-audience';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jwksResponse([{ kid: 'test-key' }]))
      .mockResolvedValueOnce(jwksResponse([{ kid: 'rotated-key' }]));
    const environment = productionEnvironment(teamDomain, audience);
    const initialToken = await signedJwt(teamDomain, audience, { sub: 'initial-subject' });
    const rotatedToken = await signedJwt(
      teamDomain,
      audience,
      { sub: 'rotated-subject' },
      'rotated-key',
    );

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': initialToken },
        }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:initial-subject', type: 'human' });
    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': rotatedToken },
        }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:rotated-subject', type: 'human' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized declared response before reading any body chunk', async () => {
    const teamDomain = 'declared-oversize-principal.cloudflareaccess.test';
    const audience = 'declared-oversize-audience';
    const stream = streamedResponse([new TextEncoder().encode('{"keys":[]}')], {
      headers: { 'content-length': String(256 * 1024 + 1) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(stream.response);
    const token = await signedJwt(teamDomain, audience, { sub: 'oversize-subject' });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).rejects.toMatchObject({ code: 'access_keys_invalid', status: 503 });
    expect(stream.readCount()).toBe(0);
    expect(stream.cancelled()).toBe(false);
  });

  it.each(['not-a-number', '-1', 'Infinity', '999999999999999999999999', '1, 1'])(
    'rejects an unsafe Content-Length value (%s) before reading',
    async (contentLength) => {
      const teamDomain = `invalid-length-${contentLength.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.cloudflareaccess.test`;
      const audience = `${contentLength}-audience`;
      const stream = streamedResponse([new TextEncoder().encode('{"keys":[]}')], {
        headers: { 'content-length': contentLength },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(stream.response);
      const token = await signedJwt(teamDomain, audience, { sub: 'invalid-length-subject' });

      await expect(
        authenticateAccessPrincipal(
          new Request('https://registry.test/session', {
            headers: { 'Cf-Access-Jwt-Assertion': token },
          }),
          productionEnvironment(teamDomain, audience),
        ),
      ).rejects.toMatchObject({ code: 'access_keys_invalid', status: 503 });
      expect(stream.readCount()).toBe(0);
    },
  );

  it('cancels a chunked response as soon as the incremental limit is exceeded', async () => {
    const teamDomain = 'chunked-oversize-principal.cloudflareaccess.test';
    const audience = 'chunked-oversize-audience';
    const stream = streamedResponse([
      new Uint8Array(200 * 1024),
      new Uint8Array(100 * 1024),
      new Uint8Array([0x7d]),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(stream.response);
    const token = await signedJwt(teamDomain, audience, { sub: 'chunked-oversize-subject' });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).rejects.toMatchObject({ code: 'access_keys_invalid', status: 503 });
    expect(stream.readCount()).toBe(2);
    expect(stream.cancelled()).toBe(true);
  });

  it('accepts valid JSON whose streamed body is exactly at the byte limit', async () => {
    const teamDomain = 'exact-limit-principal.cloudflareaccess.test';
    const audience = 'exact-limit-audience';
    const prefix = jwksBytes({ kid: 'test-key' });
    const body = new Uint8Array(256 * 1024);
    body.set(prefix);
    body.fill(0x20, prefix.byteLength);
    const stream = streamedResponse([body], {
      headers: { 'content-length': String(body.byteLength) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(stream.response);
    const token = await signedJwt(teamDomain, audience, { sub: 'exact-limit-subject' });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).resolves.toEqual({ identity: 'access:exact-limit-subject', type: 'human' });
    expect(stream.readCount()).toBe(1);
    expect(stream.cancelled()).toBe(false);
  });

  it('fails closed for a missing body, invalid JSON, HTTP error, and redirect', async () => {
    const cases: Array<{
      label: string;
      response?: Response;
      error?: Error;
    }> = [
      {
        label: 'missing-body',
        response: { ok: true, status: 200, headers: new Headers(), body: null } as Response,
      },
      {
        label: 'invalid-json',
        response: streamedResponse([new TextEncoder().encode('{')]).response,
      },
      { label: 'http-error', response: new Response(null, { status: 503 }) },
      { label: 'redirect', error: new TypeError('redirect disallowed') },
    ];

    for (const [index, entry] of cases.entries()) {
      const teamDomain = `fail-closed-${entry.label}-${index}.cloudflareaccess.test`;
      const audience = `fail-closed-${entry.label}-${index}-audience`;
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      if (entry.error !== undefined) fetchMock.mockRejectedValue(entry.error);
      else fetchMock.mockResolvedValue(entry.response as Response);
      const token = await signedJwt(teamDomain, audience, { sub: `${entry.label}-subject` });

      await expect(
        authenticateAccessPrincipal(
          new Request('https://registry.test/session', {
            headers: { 'Cf-Access-Jwt-Assertion': token },
          }),
          productionEnvironment(teamDomain, audience),
        ),
      ).rejects.toMatchObject({ code: 'access_keys_unavailable', status: 503 });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://${teamDomain}/cdn-cgi/access/certs`,
        expect.objectContaining({ redirect: 'error' }),
      );
      vi.restoreAllMocks();
    }
  });

  it('verifies a valid Access assertion without a Cache API', async () => {
    const teamDomain = 'cacheless-principal.cloudflareaccess.test';
    const audience = 'cacheless-audience';
    vi.stubGlobal('caches', undefined);
    mockSigningKeys();
    const token = await signedJwt(teamDomain, audience, { sub: 'cacheless-subject' });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).resolves.toEqual({ identity: 'access:cacheless-subject', type: 'human' });
  });

  it('maps a valid service token to service:<common_name> even when sub is present', async () => {
    const teamDomain = 'service-principal.cloudflareaccess.test';
    const audience = 'service-audience';
    mockSigningKeys();
    const token = await signedJwt(teamDomain, audience, {
      common_name: 'automation-client',
      sub: 'service-token-subject',
    });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).resolves.toEqual({ identity: 'service:automation-client', type: 'service' });
  });

  it('does not use email as an actor identity fallback', async () => {
    const teamDomain = 'email-only.cloudflareaccess.test';
    const audience = 'email-only-audience';
    mockSigningKeys();
    const token = await signedJwt(teamDomain, audience, {
      email: 'person@example.test',
    });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).rejects.toMatchObject({ code: 'access_required', status: 401 });
  });

  it('rejects an invalid signature and missing production configuration', async () => {
    const teamDomain = 'invalid-signature.cloudflareaccess.test';
    const audience = 'invalid-signature-audience';
    mockSigningKeys();
    const token = await signedJwt(teamDomain, audience, { sub: 'human-subject' });
    const invalidToken = corruptJwtSignature(token);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session', {
          headers: { 'Cf-Access-Jwt-Assertion': invalidToken },
        }),
        productionEnvironment(teamDomain, audience),
      ),
    ).rejects.toMatchObject({ code: 'access_required', status: 401 });

    await expect(
      authenticateAccessPrincipal(
        new Request('https://registry.test/session'),
        productionEnvironment('unset', 'unset'),
      ),
    ).rejects.toMatchObject({ code: 'access_configuration_missing', status: 503 });
  });

  it('accepts only canonical identities in development mode', async () => {
    const localSecret = generatedLocalSecret();
    const developmentEnvironment: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: localSecret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };

    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: {
            host: 'localhost',
            'x-global-registry-dev-secret': localSecret,
            'x-global-registry-dev-identity': 'service:local-automation',
          },
        }),
        developmentEnvironment,
      ),
    ).resolves.toEqual({ identity: 'service:local-automation', type: 'service' });

    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: {
            host: 'localhost',
            'x-global-registry-dev-secret': localSecret,
            'x-global-registry-dev-identity': 'person@example.test',
          },
        }),
        developmentEnvironment,
      ),
    ).rejects.toMatchObject({ code: 'access_required', status: 401 });
  });

  it('rejects remotely reachable, forwarded, spoofed-host, and disabled local-auth requests', async () => {
    const localSecret = generatedLocalSecret();
    const developmentEnvironment: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: localSecret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };
    const secretHeaders = {
      'x-global-registry-dev-secret': localSecret,
      'x-global-registry-dev-identity': 'access:local-admin',
    };

    await expect(
      authenticateAccessPrincipal(
        new Request('https://remote.example/session', {
          headers: { ...secretHeaders, host: 'localhost' },
        }),
        developmentEnvironment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });

    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1/session', {
          headers: { ...secretHeaders, host: 'localhost' },
        }),
        developmentEnvironment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });

    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: { ...secretHeaders, host: 'localhost', 'x-forwarded-for': '127.0.0.1' },
        }),
        developmentEnvironment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });

    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: { ...secretHeaders, host: 'localhost', 'x-forwarded-host': 'localhost' },
        }),
        { ...developmentEnvironment, ENVIRONMENT: 'production' },
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });

    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', {
          headers: { ...secretHeaders, host: '127.0.0.1:8787' },
        }),
        developmentEnvironment,
      ),
    ).resolves.toEqual({ identity: 'access:local-admin', type: 'human' });

    const credentialBearingRequest = new Request('http://127.0.0.1:8787/session', {
      headers: { ...secretHeaders, host: '127.0.0.1:8787' },
    });
    Object.defineProperty(credentialBearingRequest, 'url', {
      value: 'http://absolute-form-user:absolute-form-password@127.0.0.1:8787/session',
    });
    await expect(
      authenticateAccessPrincipal(credentialBearingRequest, developmentEnvironment),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
  });

  it.each([
    'forwarded',
    'x-forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-ssl',
    'x-real-ip',
    'x-original-url',
    'x-original-host',
    'client-ip',
    'true-client-ip',
    'x-client-ip',
    'x-cluster-client-ip',
    'x-remote-ip',
    'x-remote-addr',
    'forwarded-for',
    'via',
    'cf-connecting-ipv6',
    'cf-pseudo-ipv4',
    'cf-visitor',
    'x-proxy-host',
    'x-proxy',
    'x-original',
    'x-envoy',
    'x-amzn',
    'x-azure',
    'x-vercel',
    'x-appengine',
  ])('rejects proxy context header %s', async (header) => {
    const localSecret = generatedLocalSecret();
    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: {
            host: 'localhost',
            'x-global-registry-dev-secret': localSecret,
            'x-global-registry-dev-identity': 'access:local-admin',
            [header]: '127.0.0.1',
          },
        }),
        {
          ACCESS_AUD: 'unset',
          ACCESS_TEAM_DOMAIN: 'unset',
          ALLOW_LOCAL_AUTH: 'true',
          ENVIRONMENT: 'development',
          LOCAL_AUTH_SECRET: localSecret,
          LOCAL_ACTOR_IDENTITY: 'access:local-admin',
        },
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
  });

  it('fails closed when the local secret is missing, weak, or incorrect', async () => {
    const localSecret = generatedLocalSecret();
    const base: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: localSecret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };
    const request = (secret: string | null) =>
      new Request('http://localhost/session', {
        headers: {
          host: 'localhost',
          ...(secret === null ? {} : { 'x-global-registry-dev-secret': secret }),
        },
      });

    await expect(
      authenticateAccessPrincipal(request(null), { ...base, LOCAL_AUTH_SECRET: 'unset' }),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
    await expect(
      authenticateAccessPrincipal(request('short'), { ...base, LOCAL_AUTH_SECRET: 'short' }),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
    await expect(authenticateAccessPrincipal(request('wrong-secret'), base)).rejects.toMatchObject({
      code: 'access_required',
      status: 401,
    });

    const whitespaceSecret = ` ${generatedLocalSecret()} `;
    await expect(
      authenticateAccessPrincipal(request(whitespaceSecret), {
        ...base,
        LOCAL_AUTH_SECRET: whitespaceSecret,
      }),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
  });

  it('cannot authenticate with the checked-in example value', async () => {
    const exampleSecret = await exampleLocalAuthSecret();
    const environment: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: exampleSecret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };
    const request = new Request('http://localhost/session', {
      headers: {
        host: 'localhost',
        'x-global-registry-dev-secret': exampleSecret,
        'x-global-registry-dev-identity': 'access:local-admin',
      },
    });

    await expect(authenticateAccessPrincipal(request, environment)).rejects.toMatchObject({
      code: 'local_auth_not_configured',
      status: 503,
    });
  });

  it('accepts a generated-looking 64-character lowercase hexadecimal secret', async () => {
    const secret = '9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627a9d0e3b6c5f8142';
    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: {
            host: 'localhost',
            'x-global-registry-dev-secret': secret,
            'x-global-registry-dev-identity': 'access:local-admin',
          },
        }),
        {
          ACCESS_AUD: 'unset',
          ACCESS_TEAM_DOMAIN: 'unset',
          ALLOW_LOCAL_AUTH: 'true',
          ENVIRONMENT: 'development',
          LOCAL_AUTH_SECRET: secret,
          LOCAL_ACTOR_IDENTITY: 'access:local-admin',
        },
      ),
    ).resolves.toEqual({ identity: 'access:local-admin', type: 'human' });
  });

  it.each([
    'a'.repeat(64),
    'ab'.repeat(32),
    '0123456789abcdef'.repeat(4),
    'fedcba9876543210'.repeat(4),
    '01234567'.repeat(8),
    '9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627a9d0e3b6c5f814',
    '9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627a9d0e3b6c5f8142 ',
    '9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627a9d0e3b6c5f814g',
    '9F0C4A7E2B6D1F83C5A907E4D8B21C6F0A3E5D79B4C8F1627A9D0E3B6C5F8142',
    'example_secret_9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627',
    'EXAMPLE-SECRET-9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79b4c8f1627',
    'replace-with-a-random-secret-9f0c4a7e2b6d1f83c5a907e4d8b21c6f0a3e5d79',
    '0'.repeat(56) + '12345678',
    utf8Hex('change-me-please-not-prod-123456'),
    utf8Hex('CHANGE ME PLEASE NOT PROD 123456'),
    utf8Hex('change_me_please_not_prod_123456'),
    'unset',
  ])('rejects predictable or noncanonical local secret %s', async (secret) => {
    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: {
            host: 'localhost',
            'x-global-registry-dev-secret': secret,
            'x-global-registry-dev-identity': 'access:local-admin',
          },
        }),
        {
          ACCESS_AUD: 'unset',
          ACCESS_TEAM_DOMAIN: 'unset',
          ALLOW_LOCAL_AUTH: 'true',
          ENVIRONMENT: 'development',
          LOCAL_AUTH_SECRET: secret,
          LOCAL_ACTOR_IDENTITY: 'access:local-admin',
        },
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
  });

  it.each([
    'change-me',
    'example-secret',
    'local-dev-secret',
    'local-test-secret',
    'password',
    'replace-with-a-random-local-secret',
    'replace-with-a-random-secret',
    'secret',
    'your-local-secret',
  ])('rejects a reserved placeholder prefix with direct suffix %s', async (prefix) => {
    const secret = `${prefix}${generatedLocalSecret()}`;
    const request = new Request('http://localhost/session', {
      headers: {
        host: 'localhost',
        'x-global-registry-dev-secret': secret,
        'x-global-registry-dev-identity': 'access:local-admin',
      },
    });
    await expect(
      authenticateAccessPrincipal(request, {
        ACCESS_AUD: 'unset',
        ACCESS_TEAM_DOMAIN: 'unset',
        ALLOW_LOCAL_AUTH: 'true',
        ENVIRONMENT: 'development',
        LOCAL_AUTH_SECRET: secret,
        LOCAL_ACTOR_IDENTITY: 'access:local-admin',
      }),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
  });

  it.each([
    `EXAMPLE-SECRET${'a'.repeat(32)}`,
    `secret-${'b'.repeat(32)}`,
    `replace-with-a-random-secret-${'c'.repeat(64)}`,
  ])('rejects case-folded or hyphen-derived placeholder %s', async (secret) => {
    const request = new Request('http://localhost/session', {
      headers: {
        host: 'localhost',
        'x-global-registry-dev-secret': secret,
        'x-global-registry-dev-identity': 'access:local-admin',
      },
    });
    await expect(
      authenticateAccessPrincipal(request, {
        ACCESS_AUD: 'unset',
        ACCESS_TEAM_DOMAIN: 'unset',
        ALLOW_LOCAL_AUTH: 'true',
        ENVIRONMENT: 'development',
        LOCAL_AUTH_SECRET: secret,
        LOCAL_ACTOR_IDENTITY: 'access:local-admin',
      }),
    ).rejects.toMatchObject({ code: 'local_auth_not_configured', status: 503 });
  });

  it('allows a fresh generated secret only for exact loopback requests', async () => {
    const localSecret = generatedLocalSecret();
    const environment: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: localSecret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };
    const headers = {
      host: 'localhost',
      'x-global-registry-dev-secret': localSecret,
      'x-global-registry-dev-identity': 'access:local-admin',
    };

    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', { headers }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:local-admin', type: 'human' });
    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', {
          headers: {
            ...headers,
            host: '127.0.0.1:8787',
            'cf-connecting-ip': '127.0.0.1',
          },
        }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:local-admin', type: 'human' });
    await expect(
      authenticateAccessPrincipal(
        new Request('http://localhost/session', {
          headers: { ...headers, 'x-forwarded-host': 'localhost' },
        }),
        environment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', {
          headers: {
            ...headers,
            host: '127.0.0.1:8787',
            'cf-connecting-ip': '192.0.2.10',
          },
        }),
        environment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', {
          headers: {
            ...headers,
            host: '127.0.0.1:8787',
            'cf-connecting-ip': '127.0.0.1, 127.0.0.1',
          },
        }),
        environment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
    await expect(
      authenticateAccessPrincipal(new Request('http://localhost/session', { headers }), {
        ...environment,
        ENVIRONMENT: 'production',
      }),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
  });

  it.each([
    'forwarded',
    'x-forwarded-for',
    'x_forwarded_for',
    'x-forwarded',
    'x-proxy-host',
    'x_proxy_host',
    'x-real-ip',
    'x-original-url',
    'x-envoy-external-address',
    'x-amzn-trace-id',
    'x-azure-clientip',
    'x-vercel-proxied-for',
    'cf-visitor',
    'x-cf-connecting-ip',
    'x_cf_connecting_ip',
    'x-cf-ray',
    'x_cloudflare_ray',
    'cf_connecting_ip',
    'client-ip',
    'true-client-ip',
    'via',
    'fly-client-ip',
  ])('rejects proxy context header family member %s', async (headerName) => {
    const secret = generatedLocalSecret();
    const headers = new Headers({
      host: '127.0.0.1:8787',
      'x-global-registry-dev-secret': secret,
      'x-global-registry-dev-identity': 'access:local-admin',
    });
    headers.set(headerName, '127.0.0.1');
    await expect(
      authenticateAccessPrincipal(new Request('http://127.0.0.1:8787/session', { headers }), {
        ACCESS_AUD: 'unset',
        ACCESS_TEAM_DOMAIN: 'unset',
        ALLOW_LOCAL_AUTH: 'true',
        ENVIRONMENT: 'development',
        LOCAL_AUTH_SECRET: secret,
        LOCAL_ACTOR_IDENTITY: 'access:local-admin',
      }),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
  });

  it('allows unrelated headers and rejects a duplicate permitted Wrangler header', async () => {
    const secret = generatedLocalSecret();
    const environment: AccessEnvironment = {
      ACCESS_AUD: 'unset',
      ACCESS_TEAM_DOMAIN: 'unset',
      ALLOW_LOCAL_AUTH: 'true',
      ENVIRONMENT: 'development',
      LOCAL_AUTH_SECRET: secret,
      LOCAL_ACTOR_IDENTITY: 'access:local-admin',
    };
    const headers = new Headers({
      host: '127.0.0.1:8787',
      'x-global-registry-dev-secret': secret,
      'x-global-registry-dev-identity': 'access:local-admin',
      'x-request-id': 'local-only-test',
      'user-agent': 'test',
      'cf-connecting-ip': '127.0.0.1',
    });
    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', { headers }),
        environment,
      ),
    ).resolves.toEqual({ identity: 'access:local-admin', type: 'human' });

    headers.append('cf-connecting-ip', '127.0.0.1');
    await expect(
      authenticateAccessPrincipal(
        new Request('http://127.0.0.1:8787/session', { headers }),
        environment,
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed', status: 503 });
  });
});
