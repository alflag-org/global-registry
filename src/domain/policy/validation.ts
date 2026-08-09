import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import { ensureJsonObject } from '../models/json';
import type { PolicyDefinition } from './model';
import { policyDefinitionSchema } from './schemas';

export function validatePolicyDefinition(value: unknown): PolicyDefinition {
  const result = policyDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_policy',
      'Policy definition is invalid.',
      violationsDetails(zodViolations(result.error)),
    );
  }
  return {
    namespace: result.data.namespace,
    key: result.data.key,
    resourceKind: result.data.resourceKind,
    spec: ensureJsonObject(result.data.spec, 'policy spec'),
  };
}
