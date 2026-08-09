import { AuthorizationError } from '../domain/errors/global-registry-error';
import type { Actor, ActorRole, Operation } from '../domain/models/global-registry';

export const operationRolePolicy = {
  defaultRoles: ['provisioner', 'operator'],
  destructiveRoles: ['operator'],
  destructiveCondition: {
    field: 'operation.destructive',
    equals: true,
  },
} as const satisfies {
  defaultRoles: readonly ActorRole[];
  destructiveRoles: readonly ActorRole[];
  destructiveCondition: {
    field: 'operation.destructive';
    equals: true;
  };
};

export function requireActorRole(actor: Actor, ...roles: ActorRole[]): void {
  if (!roles.includes(actor.role)) {
    throw new AuthorizationError('forbidden', 'The actor role cannot perform this operation.');
  }
}

export function requireOperationRole(
  actor: Actor,
  operation: Pick<Operation, 'destructive'>,
): void {
  requireActorRole(
    actor,
    ...(operation.destructive
      ? operationRolePolicy.destructiveRoles
      : operationRolePolicy.defaultRoles),
  );
}
