import { z } from 'zod';
import { PROVIDER_CAPABILITIES } from '../provider/model';
import { hasUniqueValues } from '../unique-values';
import {
  ADDRESS_FAMILIES,
  ARCHITECTURES,
  BACKUP_REPOSITORY_TYPES,
  COMPUTE_SUBSTRATES,
  ENDPOINT_EXPOSURES,
  ENDPOINT_PROTOCOLS,
  LOCATION_CATEGORIES,
  SERVICE_TOPOLOGIES,
  VOLUME_ACCESS_MODES,
} from '../resource/model';

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');

const uniqueArray = <T extends z.ZodType>(schema: T) =>
  z.array(schema).min(1).refine(hasUniqueValues, 'Values must be unique.');

const integerBoundsSchema = z
  .object({
    minimum: z.number().int().positive().optional(),
    maximum: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) => value.minimum !== undefined || value.maximum !== undefined,
    'At least one bound is required.',
  )
  .refine(
    (value) =>
      value.minimum === undefined || value.maximum === undefined || value.minimum <= value.maximum,
    'minimum must be less than or equal to maximum.',
  );

const commonFields = {
  allowedZones: uniqueArray(stableKeySchema).optional(),
  requiredProviderCapabilities: uniqueArray(z.enum(PROVIDER_CAPABILITIES)).optional(),
};

function nonEmptyConstraint<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .strict()
    .refine(
      (value) => Object.keys(value).length > 0,
      'At least one policy constraint is required.',
    );
}

export const policySpecSchemas = {
  location: nonEmptyConstraint({
    ...commonFields,
    allowedCategories: uniqueArray(z.enum(LOCATION_CATEGORIES)).optional(),
  }),
  network: nonEmptyConstraint({
    ...commonFields,
    allowedAddressFamilies: uniqueArray(z.enum(ADDRESS_FAMILIES)).optional(),
    maximumCidrCount: z.number().int().positive().optional(),
  }),
  compute: nonEmptyConstraint({
    ...commonFields,
    allowedSubstrates: uniqueArray(z.enum(COMPUTE_SUBSTRATES)).optional(),
    allowedArchitectures: uniqueArray(z.enum(ARCHITECTURES)).optional(),
    vcpu: integerBoundsSchema.optional(),
    memoryMiB: integerBoundsSchema.optional(),
    allowedImageClasses: uniqueArray(stableKeySchema).optional(),
    allowedStorageClasses: uniqueArray(stableKeySchema).optional(),
  }),
  volume: nonEmptyConstraint({
    ...commonFields,
    capacityGiB: integerBoundsSchema.optional(),
    allowedStorageClasses: uniqueArray(stableKeySchema).optional(),
    allowedAccessModes: uniqueArray(z.enum(VOLUME_ACCESS_MODES)).optional(),
  }),
  service_cluster: nonEmptyConstraint({
    ...commonFields,
    allowedServiceTypes: uniqueArray(stableKeySchema).optional(),
    allowedTopologies: uniqueArray(z.enum(SERVICE_TOPOLOGIES)).optional(),
  }),
  service_instance: nonEmptyConstraint({
    ...commonFields,
    allowedServiceTypes: uniqueArray(stableKeySchema).optional(),
    allowedConfigurationClasses: uniqueArray(stableKeySchema).optional(),
  }),
  endpoint: nonEmptyConstraint({
    ...commonFields,
    allowedProtocols: uniqueArray(z.enum(ENDPOINT_PROTOCOLS)).optional(),
    allowedExposures: uniqueArray(z.enum(ENDPOINT_EXPOSURES)).optional(),
    port: integerBoundsSchema.optional(),
  }),
  backup_repository: nonEmptyConstraint({
    ...commonFields,
    allowedRepositoryTypes: uniqueArray(z.enum(BACKUP_REPOSITORY_TYPES)).optional(),
    allowedRetentionClasses: uniqueArray(stableKeySchema).optional(),
  }),
} as const;

export const policyDefinitionSchema = z.discriminatedUnion('resourceKind', [
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('location'),
      spec: policySpecSchemas.location,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('network'),
      spec: policySpecSchemas.network,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('compute'),
      spec: policySpecSchemas.compute,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('volume'),
      spec: policySpecSchemas.volume,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('service_cluster'),
      spec: policySpecSchemas.service_cluster,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('service_instance'),
      spec: policySpecSchemas.service_instance,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('endpoint'),
      spec: policySpecSchemas.endpoint,
    })
    .strict(),
  z
    .object({
      namespace: stableKeySchema,
      key: stableKeySchema,
      resourceKind: z.literal('backup_repository'),
      spec: policySpecSchemas.backup_repository,
    })
    .strict(),
]);
