import { AuthorizationError } from '../api/errors';
import { canonicalActorIdentitySchema, type PrincipalType } from './identity';

export interface AccessPrincipal {
  identity: string;
  type: PrincipalType;
}

// Hono's execution context omits Access; use the Workers runtime's generated type.
declare module 'hono' {
  interface ExecutionContext {
    readonly access?: CloudflareAccessContext;
  }
}

export async function authenticateAccessPrincipal(
  access: ExecutionContext['access'],
): Promise<AccessPrincipal> {
  if (!access) {
    throw new AuthorizationError('access_required', 'Cloudflare Access is required.');
  }
  let identity;
  try {
    identity = await access.getIdentity();
  } catch {
    throw new AuthorizationError('access_required', 'Cloudflare Access identity is unavailable.');
  }
  const service = identity?.service_token_status;
  if (service !== undefined && typeof service !== 'boolean') {
    throw new AuthorizationError('access_required', 'Cloudflare Access identity is invalid.');
  }
  const subject = service === true ? identity?.service_token_id : identity?.user_uuid;
  const type = service === true ? 'service' : 'human';
  const result = canonicalActorIdentitySchema.safeParse(
    typeof subject === 'string' ? `${service === true ? 'service' : 'access'}:${subject}` : null,
  );
  if (!result.success) {
    throw new AuthorizationError('access_required', 'Cloudflare Access identity is invalid.');
  }
  return { identity: result.data, type };
}
