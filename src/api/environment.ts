import type { Context } from 'hono';
import type { AccessPrincipal } from '../adapters/access/access';
import type { RegistryRepository } from '../application/ports';
import { AuthorizationError, NotFoundError } from '../domain/errors/global-registry-error';
import type { Actor, Operation } from '../domain/models/global-registry';
import { requireOperationRole } from './actor-authorization';

export type ApiEnvironment = {
  Bindings: Env;
  Variables: {
    accessPrincipal: AccessPrincipal;
    actor: Actor | null;
    repository: RegistryRepository;
    requestId: string;
  };
};

export function repository(c: Context<ApiEnvironment>): RegistryRepository {
  return c.get('repository');
}

export function actor(c: Context<ApiEnvironment>): Actor {
  const mappedActor = c.get('actor');
  if (mappedActor === null) {
    throw new AuthorizationError(
      'actor_not_registered',
      'Cloudflare Access identity is not mapped to a Global Registry actor.',
    );
  }
  return mappedActor;
}

export function mappedActor(c: Context<ApiEnvironment>): Actor | null {
  return c.get('actor');
}

export function accessPrincipal(c: Context<ApiEnvironment>): AccessPrincipal {
  return c.get('accessPrincipal');
}

export async function operationForMutation(
  c: Context<ApiEnvironment>,
  operationId: string,
): Promise<Operation> {
  const operation = await repository(c).getOperation(operationId);
  if (operation === null) throw new NotFoundError('Operation', operationId);
  if (operation.actorId !== actor(c).id) {
    throw new AuthorizationError(
      'forbidden',
      'Only the actor that created the operation may mutate it.',
    );
  }
  requireOperationRole(actor(c), operation);
  return operation;
}
