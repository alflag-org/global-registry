import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import { ensureJsonObject } from '../models/json';
import type { JsonObject, ResourceKind } from '../models/global-registry';
import { placementSchema, resourceSpecOverrideSchemas, resourceSpecSchemas } from './schemas';

export function validateResourceSpec(kind: ResourceKind, value: unknown): JsonObject {
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

export function validateResourceSpecOverrides(kind: ResourceKind, value: unknown): JsonObject {
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

export function validatePlacement(kind: ResourceKind, value: unknown): JsonObject {
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
  if (kind !== 'location' && result.data.locationKey === undefined) {
    throw new ValidationError(
      'location_required',
      'A non-location resource must reference a location resource.',
      violationsDetails([
        {
          code: 'location_required',
          path: 'placement.locationKey',
          message: 'locationKey is required for non-location resources.',
        },
      ]),
    );
  }
  if (kind === 'location' && result.data.locationKey !== undefined) {
    throw new ValidationError(
      'location_cannot_reference_location',
      'A location resource cannot use placement.locationKey.',
      violationsDetails([
        {
          code: 'location_cannot_reference_location',
          path: 'placement.locationKey',
          message: 'locationKey is not allowed for location resources.',
        },
      ]),
    );
  }
  return ensureJsonObject(result.data, 'resource placement');
}
