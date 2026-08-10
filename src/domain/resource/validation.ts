import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import { ensureCredentialFreeJsonObject, ensureJsonObject } from '../models/json';
import type {
  JsonObject,
  ResourceKindDefinitionVersion,
  StandardResourceKind,
} from '../models/global-registry';
import { isStandardResourceKind } from '../resource-kind/validation';
import { placementSchema, resourceSpecOverrideSchemas, resourceSpecSchemas } from './schemas';

export function validateResourceSpec(
  definition: ResourceKindDefinitionVersion,
  value: unknown,
): JsonObject {
  if (definition.specificationMode === 'opaque') {
    return ensureCredentialFreeJsonObject(value, 'resource spec');
  }
  const kind = standardKind(definition);
  const result = resourceSpecSchemas[kind].safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_resource_spec',
      `The ${kind} resource specification is invalid.`,
      violationsDetails(zodViolations(result.error)),
    );
  }
  return ensureJsonObject(result.data, 'resource spec');
}

export function validateResourceSpecOverrides(
  definition: ResourceKindDefinitionVersion,
  value: unknown,
): JsonObject {
  if (definition.specificationMode === 'opaque') {
    return ensureCredentialFreeJsonObject(value, 'resource spec overrides');
  }
  const kind = standardKind(definition);
  const result = resourceSpecOverrideSchemas[kind].safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_resource_spec_overrides',
      `The ${kind} resource specification overrides are invalid.`,
      violationsDetails(
        zodViolations(result.error).map((violation) => ({
          ...violation,
          path: violation.path.length === 0 ? 'specOverrides' : `specOverrides.${violation.path}`,
        })),
      ),
    );
  }
  return ensureJsonObject(result.data, 'resource spec overrides');
}

export function validatePlacement(
  definition: ResourceKindDefinitionVersion,
  value: unknown,
): JsonObject {
  const result = placementSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_resource_placement',
      'Resource placement is invalid.',
      violationsDetails(
        zodViolations(result.error).map((violation) => ({
          ...violation,
          path: violation.path.length === 0 ? 'placement' : `placement.${violation.path}`,
        })),
      ),
    );
  }
  if (definition.placementMode === 'located' && result.data.locationKey === undefined) {
    throw new ValidationError(
      'location_required',
      'A Resource using located placement must reference a placement-root Resource.',
      violationsDetails([
        {
          code: 'location_required',
          path: 'placement.locationKey',
          message: 'locationKey is required when the definition uses located placement.',
        },
      ]),
    );
  }
  if (definition.placementMode === 'root' && result.data.locationKey !== undefined) {
    throw new ValidationError(
      'location_cannot_reference_location',
      'A placement-root Resource cannot use placement.locationKey.',
      violationsDetails([
        {
          code: 'location_cannot_reference_location',
          path: 'placement.locationKey',
          message: 'locationKey is not allowed when the definition uses root placement.',
        },
      ]),
    );
  }
  return ensureJsonObject(result.data, 'resource placement');
}

function standardKind(definition: ResourceKindDefinitionVersion): StandardResourceKind {
  if (!isStandardResourceKind(definition.key)) {
    throw new ValidationError(
      'invalid_resource_kind_definition',
      `Definition ${definition.key} cannot select standard specification validation.`,
    );
  }
  return definition.key;
}
