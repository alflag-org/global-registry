import { AuthorizationError, GlobalRegistryError } from '../../domain/errors/global-registry-error';
import {
  canonicalActorIdentitySchema,
  principalTypeFromIdentity,
  type PrincipalType,
} from '../../domain/actor/identity';

export interface AccessPrincipal {
  identity: string;
  type: PrincipalType;
}

export interface AccessEnvironment {
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  ALLOW_LOCAL_AUTH: string;
  ENVIRONMENT: string;
  LOCAL_AUTH_SECRET: string;
  LOCAL_ACTOR_IDENTITY: string;
}

interface AccessJwtHeader {
  kid: string;
}

interface AccessJwtClaims {
  aud: string[];
  exp: number;
  nbf?: number;
  iss: string;
  sub?: string;
  common_name?: string;
}

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

const JWKS_MEMO_TTL_MS = 5 * 60 * 1000;
const JWKS_MEMO_MAX_ENTRIES = 8;
const JWKS_RESPONSE_MAX_BYTES = 256 * 1024;
const LOCAL_AUTH_SECRET_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_AUTH_SECRET_MIN_UNIQUE_HEX_DIGITS = 8;
const LOCAL_AUTH_SECRET_MAX_REPEAT_RUN = 8;
const LOCAL_AUTH_PLACEHOLDER_MARKERS = [
  'changeme',
  'notprod',
  'placeholder',
  'password',
  'secret',
  'localdev',
  'development',
  'example',
  'your',
];
const DIRECT_PROXY_CONTEXT_HEADERS = new Set([
  'client-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-remote-ip',
  'x-remote-addr',
  'x-proxy-user',
  'forwarded-for',
  'via',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'cf-pseudo-ipv4',
  'fly-client-ip',
  'fastly-client-ip',
  'akamai-client-ip',
  'remote-ip',
  'remote-addr',
  'proxy-connection',
]);
const PROXY_CONTEXT_FAMILY_PREFIXES = [
  'x-forwarded',
  'x-proxy',
  'x-original',
  'x-envoy',
  'x-amzn',
  'x-azure',
  'x-vercel',
  'x-appengine',
];
const jwksMemo = new Map<string, { keys: AccessJwk[]; expiresAt: number }>();
const jwksFetches = new Map<string, Promise<AccessJwk[]>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Url(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new AuthorizationError('access_required', 'Cloudflare Access token is malformed.');
  }
  const normalized = segment.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AuthorizationError('access_required', 'Cloudflare Access token is malformed.');
  }
}

function parseJsonSegment(segment: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new AuthorizationError('access_required', `Cloudflare Access ${label} is malformed.`);
  }
}

function parseHeader(value: Record<string, unknown>): AccessJwtHeader {
  if (value.alg !== 'RS256' || typeof value.kid !== 'string' || value.kid.length === 0) {
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access token uses an unsupported signature.',
    );
  }
  return { kid: value.kid };
}

function parseClaims(value: Record<string, unknown>): AccessJwtClaims {
  const aud = value.aud;
  if (
    !Array.isArray(aud) ||
    aud.length === 0 ||
    !aud.every((item) => typeof item === 'string') ||
    typeof value.exp !== 'number' ||
    !Number.isFinite(value.exp) ||
    typeof value.iss !== 'string'
  ) {
    throw new AuthorizationError('access_required', 'Cloudflare Access token claims are invalid.');
  }
  const optionalString = (name: string): string | undefined =>
    typeof value[name] === 'string' ? value[name] : undefined;
  const optionalNumber = (name: string): number | undefined => {
    if (value[name] === undefined) return undefined;
    if (typeof value[name] !== 'number' || !Number.isFinite(value[name])) {
      throw new AuthorizationError(
        'access_required',
        'Cloudflare Access token claims are invalid.',
      );
    }
    return value[name];
  };
  const nbf = optionalNumber('nbf');
  const sub = optionalString('sub');
  const commonName = optionalString('common_name');
  return {
    aud,
    exp: value.exp,
    iss: value.iss,
    ...(nbf === undefined ? {} : { nbf }),
    ...(sub === undefined ? {} : { sub }),
    ...(commonName === undefined ? {} : { common_name: commonName }),
  };
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeTeamDomain(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('unexpected Access team URL');
    }
    return url.hostname;
  } catch {
    throw new GlobalRegistryError(
      503,
      'access_configuration_invalid',
      'Cloudflare Access configuration is invalid.',
    );
  }
}

function parseJwks(value: unknown): AccessJwk[] {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new GlobalRegistryError(
      503,
      'access_keys_invalid',
      'Cloudflare Access signing keys are invalid.',
    );
  }
  return value.keys.flatMap((key) => {
    if (
      !isRecord(key) ||
      typeof key.kid !== 'string' ||
      typeof key.kty !== 'string' ||
      typeof key.n !== 'string' ||
      typeof key.e !== 'string'
    ) {
      return [];
    }
    return [
      {
        kid: key.kid,
        kty: key.kty,
        n: key.n,
        e: key.e,
        ...(typeof key.alg === 'string' ? { alg: key.alg } : {}),
        ...(typeof key.use === 'string' ? { use: key.use } : {}),
      },
    ];
  });
}

function invalidJwksResponseError(): GlobalRegistryError {
  return new GlobalRegistryError(
    503,
    'access_keys_invalid',
    'Cloudflare Access signing keys are invalid.',
  );
}

function unavailableJwksResponseError(): GlobalRegistryError {
  return new GlobalRegistryError(
    503,
    'access_keys_unavailable',
    'Cloudflare Access signing keys are unavailable.',
  );
}

function declaredResponseLength(headers: Headers): number | 'invalid' | 'missing' {
  const value = headers.get('content-length');
  if (value === null) return 'missing';
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length !== 1 || entries[0] === undefined || !/^\d+$/.test(entries[0])) {
    return 'invalid';
  }
  const length = Number(entries[0]);
  return Number.isSafeInteger(length) && length >= 0 ? length : 'invalid';
}

async function readBoundedJwksBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw unavailableJwksResponseError();
  const reader = response.body.getReader();
  const body = new Uint8Array(JWKS_RESPONSE_MAX_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > JWKS_RESPONSE_MAX_BYTES - bytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidJwksResponseError();
      }
      body.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return body.subarray(0, bytes);
  } catch (error) {
    if (error instanceof GlobalRegistryError) throw error;
    throw unavailableJwksResponseError();
  } finally {
    reader.releaseLock();
  }
}

async function fetchSigningKeys(teamDomain: string): Promise<AccessJwk[]> {
  const certificateUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  try {
    const response = await fetch(certificateUrl, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) {
      throw new GlobalRegistryError(
        503,
        'access_keys_unavailable',
        'Cloudflare Access signing keys are unavailable.',
      );
    }
    const contentLength = declaredResponseLength(response.headers);
    if (
      contentLength === 'invalid' ||
      (typeof contentLength === 'number' && contentLength > JWKS_RESPONSE_MAX_BYTES)
    ) {
      throw invalidJwksResponseError();
    }
    const body = await readBoundedJwksBody(response);
    return parseJwks(JSON.parse(new TextDecoder().decode(body)) as unknown);
  } catch (error) {
    if (error instanceof GlobalRegistryError) throw error;
    throw unavailableJwksResponseError();
  }
}

function memoizeSigningKeys(teamDomain: string, keys: AccessJwk[]): AccessJwk[] {
  if (jwksMemo.size >= JWKS_MEMO_MAX_ENTRIES && !jwksMemo.has(teamDomain)) {
    const oldest = jwksMemo.keys().next().value;
    if (oldest !== undefined) jwksMemo.delete(oldest);
  }
  jwksMemo.set(teamDomain, { keys, expiresAt: Date.now() + JWKS_MEMO_TTL_MS });
  return keys;
}

async function getSigningKey(teamDomain: string, kid: string): Promise<AccessJwk | undefined> {
  const cached = jwksMemo.get(teamDomain);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    const key = cached.keys.find((candidate) => candidate.kid === kid);
    if (key !== undefined) return key;
  }

  let fetchPromise = jwksFetches.get(teamDomain);
  if (fetchPromise === undefined) {
    fetchPromise = fetchSigningKeys(teamDomain);
    jwksFetches.set(teamDomain, fetchPromise);
  }
  try {
    const refreshed = memoizeSigningKeys(teamDomain, await fetchPromise);
    return refreshed.find((candidate) => candidate.kid === kid);
  } finally {
    if (jwksFetches.get(teamDomain) === fetchPromise) jwksFetches.delete(teamDomain);
  }
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessPrincipal> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthorizationError('access_required', 'Cloudflare Access token is malformed.');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    throw new AuthorizationError('access_required', 'Cloudflare Access token is malformed.');
  }
  const header = parseHeader(parseJsonSegment(headerSegment, 'header'));
  const claims = parseClaims(parseJsonSegment(payloadSegment, 'payload'));
  const currentSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.exp <= currentSeconds ||
    (claims.nbf !== undefined && claims.nbf > currentSeconds) ||
    claims.iss !== `https://${teamDomain}` ||
    !claims.aud.includes(audience)
  ) {
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access token is not valid for this application.',
    );
  }
  const jwk = await getSigningKey(teamDomain, header.kid);
  if (
    jwk === undefined ||
    jwk.kty !== 'RSA' ||
    (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
    (jwk.use !== undefined && jwk.use !== 'sig')
  ) {
    throw new AuthorizationError('access_required', 'Cloudflare Access signing key was not found.');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    asArrayBuffer(decodeBase64Url(signatureSegment)),
    asArrayBuffer(new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)),
  );
  if (!valid) {
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access token signature is invalid.',
    );
  }
  if (claims.common_name !== undefined && claims.common_name.length > 0) {
    return canonicalPrincipal(`service:${claims.common_name}`);
  }
  if (claims.sub !== undefined && claims.sub.length > 0) {
    return canonicalPrincipal(`access:${claims.sub}`);
  }
  throw new AuthorizationError(
    'access_required',
    'Cloudflare Access token has no usable actor identity.',
  );
}

function canonicalPrincipal(identity: string): AccessPrincipal {
  const result = canonicalActorIdentitySchema.safeParse(identity);
  if (!result.success) {
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access token has no usable actor identity.',
    );
  }
  return {
    identity: result.data,
    type: principalTypeFromIdentity(result.data),
  };
}

function hasUsableLocalAuthSecret(secret: string): boolean {
  if (!LOCAL_AUTH_SECRET_PATTERN.test(secret)) return false;
  if (new Set(secret).size < LOCAL_AUTH_SECRET_MIN_UNIQUE_HEX_DIGITS) return false;
  if (hasLongHexRun(secret)) return false;
  if (isObviousPlaceholderSecret(secret)) return false;

  for (let period = 1; period <= 16; period += 1) {
    let repeats = true;
    for (let index = period; index < secret.length; index += 1) {
      if (secret[index] !== secret[index % period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return false;
  }

  const digits = [...secret].map((character) => Number.parseInt(character, 16));
  const sequential = (step: number) =>
    digits.every(
      (digit, index) => index === 0 || (digit - (digits[index - 1] ?? digit) + 16) % 16 === step,
    );
  return !sequential(1) && !sequential(15);
}

function hasLongHexRun(secret: string): boolean {
  let run = 1;
  for (let index = 1; index < secret.length; index += 1) {
    if (secret[index] === secret[index - 1]) {
      run += 1;
      if (run >= LOCAL_AUTH_SECRET_MAX_REPEAT_RUN) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function isObviousPlaceholderSecret(secret: string): boolean {
  const bytes = new Uint8Array(secret.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16);
  }
  const decoded = new TextDecoder().decode(bytes);
  const normalized = decoded.toLowerCase().replace(/[^a-z0-9]/g, '');
  return LOCAL_AUTH_PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

function hasForwardedProxyContext(headers: Headers): boolean {
  let permittedWranglerHeaderSeen = false;
  for (const header of headers.keys()) {
    const rawName = header.toLowerCase();
    const name = canonicalProxyHeaderName(rawName);
    if (rawName === 'cf-connecting-ip') {
      if (permittedWranglerHeaderSeen || headers.get(header) !== '127.0.0.1') return true;
      permittedWranglerHeaderSeen = true;
      continue;
    }
    if (
      name === 'forwarded' ||
      PROXY_CONTEXT_FAMILY_PREFIXES.some(
        (prefix) => name === prefix || name.startsWith(`${prefix}-`),
      ) ||
      name === 'x-real-ip' ||
      name === 'x-cf' ||
      name.startsWith('x-cf-') ||
      name === 'x-cloudflare' ||
      name.startsWith('x-cloudflare-') ||
      name.startsWith('cf-') ||
      DIRECT_PROXY_CONTEXT_HEADERS.has(name)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalProxyHeaderName(header: string): string {
  return header.toLowerCase().replaceAll('_', '-');
}

async function matchesLocalAuthSecret(provided: string | null, expected: string): Promise<boolean> {
  if (provided === null) return false;
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = providedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function authenticateAccessPrincipal(
  request: Request,
  env: AccessEnvironment,
): Promise<AccessPrincipal> {
  if (env.ALLOW_LOCAL_AUTH === 'true') {
    if (env.ENVIRONMENT !== 'development') {
      throw new GlobalRegistryError(
        503,
        'local_auth_not_allowed',
        'Development authentication is only permitted in the development environment.',
      );
    }
    const url = new URL(request.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const hostHeader = request.headers.get('host');
    if (
      url.protocol !== 'http:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
      hostHeader !== url.host ||
      hasForwardedProxyContext(request.headers)
    ) {
      throw new GlobalRegistryError(
        503,
        'local_auth_not_allowed',
        'Development authentication is only permitted on an unforwarded loopback request.',
      );
    }
    if (!hasUsableLocalAuthSecret(env.LOCAL_AUTH_SECRET)) {
      throw new GlobalRegistryError(
        503,
        'local_auth_not_configured',
        'Development authentication requires exactly 64 lowercase hexadecimal characters generated from 32 random bytes; trivial and placeholder values are rejected.',
      );
    }
    if (
      !(await matchesLocalAuthSecret(
        request.headers.get('x-global-registry-dev-secret'),
        env.LOCAL_AUTH_SECRET,
      ))
    ) {
      throw new AuthorizationError(
        'access_required',
        'Development authentication requires the configured local secret.',
      );
    }
    const developmentIdentity =
      request.headers.get('x-global-registry-dev-identity') ?? env.LOCAL_ACTOR_IDENTITY;
    if (developmentIdentity === 'unset' || developmentIdentity.length === 0) {
      throw new AuthorizationError(
        'access_required',
        'Development requests require x-global-registry-dev-identity or LOCAL_ACTOR_IDENTITY.',
      );
    }
    return canonicalPrincipal(developmentIdentity);
  }

  if (env.ACCESS_TEAM_DOMAIN === 'unset' || env.ACCESS_AUD === 'unset') {
    throw new GlobalRegistryError(
      503,
      'access_configuration_missing',
      'Cloudflare Access configuration has not been supplied.',
    );
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (assertion === null) {
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access authentication is required.',
    );
  }
  return verifyAccessJwt(assertion, normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN), env.ACCESS_AUD);
}
