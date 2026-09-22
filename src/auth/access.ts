import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import { AuthorizationError, GlobalRegistryError } from '../api/errors';
import {
  canonicalActorIdentitySchema,
  principalTypeFromIdentity,
  type PrincipalType,
} from './identity';

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
let signingKeys: { domain: string; resolve: ReturnType<typeof createRemoteJWKSet> } | undefined;

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

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessPrincipal> {
  if (signingKeys?.domain !== teamDomain) {
    signingKeys = {
      domain: teamDomain,
      resolve: createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)),
    };
  }
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, signingKeys.resolve, {
      algorithms: ['RS256'],
      issuer: `https://${teamDomain}`,
      audience,
      requiredClaims: ['exp'],
    }));
  } catch (error) {
    if (
      error instanceof errors.JWKSTimeout ||
      error instanceof errors.JWKSInvalid ||
      (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') ||
      !(error instanceof errors.JOSEError)
    ) {
      throw new GlobalRegistryError(
        503,
        'access_keys_unavailable',
        'Cloudflare Access signing keys are unavailable.',
      );
    }
    throw new AuthorizationError(
      'access_required',
      'Cloudflare Access token signature or claims are invalid.',
    );
  }
  if (typeof claims.common_name === 'string' && claims.common_name.length > 0) {
    return canonicalPrincipal(`service:${claims.common_name}`);
  }
  if (typeof claims.sub === 'string' && claims.sub.length > 0) {
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
