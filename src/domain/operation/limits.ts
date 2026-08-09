import { ValidationError } from '../errors/global-registry-error';
import type { JsonObject } from '../models/global-registry';

// One operation is kept below the D1 batch statement budget: create emits one
// statement per resource, step, and planned change, plus three fixed statements.
export const MAX_OPERATION_RESOURCES = 32;
export const MAX_OPERATION_STEPS = 32;
export const MAX_OPERATION_CHANGES = 32;
export const MAX_OPERATION_WORK_BYTES = 128 * 1024;
export const MAX_LOCK_SCOPES = 32;

export function assertOperationLimits(input: {
  intent: JsonObject;
  resources: readonly unknown[];
  changes: readonly unknown[];
  steps: readonly unknown[];
}): void {
  if (input.resources.length > MAX_OPERATION_RESOURCES) {
    throw new ValidationError(
      'operation_resources_limit',
      `An operation may include at most ${MAX_OPERATION_RESOURCES} resources.`,
    );
  }
  if (input.steps.length > MAX_OPERATION_STEPS) {
    throw new ValidationError(
      'operation_steps_limit',
      `An operation may include at most ${MAX_OPERATION_STEPS} steps.`,
    );
  }
  if (input.changes.length > MAX_OPERATION_CHANGES) {
    throw new ValidationError(
      'operation_changes_limit',
      `An operation may include at most ${MAX_OPERATION_CHANGES} changes.`,
    );
  }
  const work = JSON.stringify({
    intent: input.intent,
    resources: input.resources,
    changes: input.changes,
    steps: input.steps,
  });
  const bytes = new TextEncoder().encode(work).byteLength;
  if (bytes > MAX_OPERATION_WORK_BYTES) {
    throw new ValidationError(
      'operation_work_limit',
      `The operation plan exceeds the ${MAX_OPERATION_WORK_BYTES}-byte work limit.`,
    );
  }
}
