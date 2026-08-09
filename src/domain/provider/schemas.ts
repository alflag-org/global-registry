import { z } from 'zod';
import { RESOURCE_KINDS } from '../models/global-registry';
import { isBoundedJsonObject } from '../models/json';
import { hasUniqueValues } from '../unique-values';
import { PROVIDER_STATUSES } from './model';

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');

const extensibleIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Use lowercase segments separated by dots, underscores, or hyphens.',
  );

const opaqueJsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) => isBoundedJsonObject(value),
  { message: 'Must be a bounded JSON object.' },
);

export const providerDriverSchema = extensibleIdentifierSchema.describe(
  'Stable identifier for the external provider adapter.',
);
export const providerCapabilitySchema = extensibleIdentifierSchema.describe(
  'Extensible capability identifier; use namespaced forms such as compute.vm.',
);
export const providerArchitectureSchema = extensibleIdentifierSchema.describe(
  'Architecture identifier declared by the external provider adapter.',
);

export const credentialReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use an uppercase credential binding name, not a credential value.');

export const providerCapabilitiesSchema = z
  .object({
    resourceKinds: z
      .array(z.enum(RESOURCE_KINDS))
      .min(1)
      .refine(hasUniqueValues, 'Resource kinds must be unique.'),
    features: z.array(providerCapabilitySchema).refine(hasUniqueValues, 'Features must be unique.'),
    architectures: z
      .array(providerArchitectureSchema)
      .refine(hasUniqueValues, 'Architectures must be unique.'),
  })
  .strict();

export const providerDefinitionSchema = z
  .object({
    id: stableKeySchema,
    driver: providerDriverSchema,
    credentialRef: credentialReferenceSchema,
    status: z.enum(PROVIDER_STATUSES),
    capabilities: providerCapabilitiesSchema,
    configuration: opaqueJsonObjectSchema,
    mappings: opaqueJsonObjectSchema,
  })
  .strict();

export const providerStatusSchema = z.enum(PROVIDER_STATUSES);
