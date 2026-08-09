import { ConflictError, ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import type { Operation } from '../models/global-registry';
import type { OperationChange } from './model';
import { operationChangesSchema } from './schemas';

export function validateOperationChanges(value: unknown): OperationChange[] {
  const result = operationChangesSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_operation_changes',
      'Operation changes are invalid.',
      violationsDetails(zodViolations(result.error)),
    );
  }
  return result.data;
}

export function assertRunningOperationChange(
  operation: Operation,
  expected: OperationChange,
): void {
  if (operation.status !== 'running') {
    throw new ConflictError('operation_not_running', 'The operation must be running.', {
      operationId: operation.id,
      currentStatus: operation.status,
    });
  }
  const changes = validateOperationChanges(operation.plan.changes);
  const match = changes.some((change) => sameChange(change, expected));
  if (!match) {
    throw new ConflictError(
      'operation_plan_mismatch',
      'The operation plan does not authorize this mutation.',
      {
        operationId: operation.id,
        expectedChange: { ...expected },
      },
    );
  }
}

function sameChange(actual: OperationChange, expected: OperationChange): boolean {
  if (actual.action !== expected.action || actual.resourceKey !== expected.resourceKey)
    return false;
  switch (actual.action) {
    case 'binding.replace':
      return (
        expected.action === 'binding.replace' &&
        actual.providerId === expected.providerId &&
        actual.providerResourceType === expected.providerResourceType &&
        actual.providerResourceId === expected.providerResourceId
      );
    case 'binding.remove':
      return expected.action === 'binding.remove';
    case 'relationship.create':
      return (
        expected.action === 'relationship.create' &&
        actual.targetResourceKey === expected.targetResourceKey &&
        actual.relationshipType === expected.relationshipType
      );
    case 'relationship.remove':
      return (
        expected.action === 'relationship.remove' &&
        actual.relationshipId === expected.relationshipId
      );
  }
}
