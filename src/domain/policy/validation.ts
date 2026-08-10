import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import { ensureCredentialFreeJsonObject, ensureJsonObject } from '../models/json';
import type { ResourceKindDefinitionVersion } from '../models/global-registry';
import { isStandardResourceKind } from '../resource-kind/validation';
import type { PolicyDefinition } from './model';
import { commonPolicySpecSchema, policyDefinitionSchema, policySpecSchemas } from './schemas';

export function validatePolicyDefinition(
  value: unknown,
  definition: ResourceKindDefinitionVersion,
): PolicyDefinition {
  const result = policyDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_policy',
      'Policy definition is invalid.',
      violationsDetails(zodViolations(result.error)),
    );
  }
  if (
    result.data.resourceKind !== definition.key ||
    result.data.resourceKindVersion !== definition.version
  ) {
    throw new ValidationError(
      'policy_resource_kind_mismatch',
      'Policy definition must cite the loaded Resource kind definition.',
    );
  }
  const specResult =
    definition.specificationMode === 'standard' && isStandardResourceKind(definition.key)
      ? policySpecSchemas[definition.key].safeParse(result.data.spec)
      : commonPolicySpecSchema.safeParse(result.data.spec);
  if (!specResult.success) {
    throw new ValidationError(
      'invalid_policy',
      'Policy definition is invalid.',
      violationsDetails(zodViolations(specResult.error)),
    );
  }
  const spec =
    definition.specificationMode === 'opaque'
      ? ensureCredentialFreeJsonObject(specResult.data, 'policy spec')
      : ensureJsonObject(specResult.data, 'policy spec');
  return {
    namespace: result.data.namespace,
    key: result.data.key,
    resourceKind: result.data.resourceKind,
    resourceKindVersion: result.data.resourceKindVersion,
    spec,
  };
}
