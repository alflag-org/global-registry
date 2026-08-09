import { z } from 'zod';
import { ARCHITECTURES } from '../resource/model';
import { RESOURCE_KINDS } from '../models/global-registry';
import { hasUniqueValues } from '../unique-values';
import { PROVIDER_CAPABILITIES, PROVIDER_STATUSES, type ProviderDriver } from './model';

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');
const identifierSchema = z.string().trim().min(1).max(512);
export const credentialReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use an uppercase credential binding name, not a credential value.');
const mappingRecord = <T extends z.ZodType>(value: T) => z.record(stableKeySchema, value);

export const providerCapabilitiesSchema = z
  .object({
    resourceKinds: z
      .array(z.enum(RESOURCE_KINDS))
      .min(1)
      .refine(hasUniqueValues, 'Resource kinds must be unique.'),
    features: z
      .array(z.enum(PROVIDER_CAPABILITIES))
      .refine(hasUniqueValues, 'Features must be unique.'),
    architectures: z
      .array(z.enum(ARCHITECTURES))
      .refine(hasUniqueValues, 'Architectures must be unique.'),
  })
  .strict();

const mappingSet = <N extends z.ZodType, S extends z.ZodType, I extends z.ZodType>(
  network: N,
  storage: S,
  image: I,
) =>
  z
    .object({
      networks: mappingRecord(network),
      storageClasses: mappingRecord(storage),
      imageClasses: mappingRecord(image),
    })
    .strict();

const proxmoxMappingsSchema = mappingSet(
  z
    .object({
      bridge: identifierSchema,
      vlanTag: z.number().int().min(1).max(4094).optional(),
    })
    .strict(),
  z.object({ storage: identifierSchema }).strict(),
  z.object({ templateId: identifierSchema }).strict(),
);

const cloudflareMappingsSchema = mappingSet(
  z.object({ accountId: identifierSchema, zoneId: identifierSchema }).strict(),
  z.object({ bucketName: identifierSchema }).strict(),
  z.object({ scriptName: identifierSchema }).strict(),
);

const awsMappingsSchema = mappingSet(
  z
    .object({
      vpcId: identifierSchema,
      subnetIds: z
        .array(identifierSchema)
        .min(1)
        .refine(hasUniqueValues, 'Subnet IDs must be unique.'),
    })
    .strict(),
  z
    .object({
      service: z.enum(['ebs', 'efs', 's3']),
      class: identifierSchema,
    })
    .strict(),
  z.object({ amiId: identifierSchema }).strict(),
);

const gcpMappingsSchema = mappingSet(
  z
    .object({
      project: identifierSchema,
      network: identifierSchema,
      subnetwork: identifierSchema.optional(),
    })
    .strict(),
  z.object({ project: identifierSchema, type: identifierSchema }).strict(),
  z.object({ project: identifierSchema, image: identifierSchema }).strict(),
);

export const providerMappingSchemas = {
  proxmox: proxmoxMappingsSchema,
  cloudflare: cloudflareMappingsSchema,
  aws: awsMappingsSchema,
  gcp: gcpMappingsSchema,
} as const;

function providerSchema<T extends ProviderDriver, M extends z.ZodType>(driver: T, mappings: M) {
  return z
    .object({
      id: stableKeySchema,
      driver: z.literal(driver),
      credentialRef: credentialReferenceSchema,
      status: z.enum(PROVIDER_STATUSES),
      capabilities: providerCapabilitiesSchema,
      mappings,
    })
    .strict();
}

export const providerDefinitionSchema = z.discriminatedUnion('driver', [
  providerSchema('proxmox', proxmoxMappingsSchema),
  providerSchema('cloudflare', cloudflareMappingsSchema),
  providerSchema('aws', awsMappingsSchema),
  providerSchema('gcp', gcpMappingsSchema),
]);

export const providerStatusSchema = z.enum(PROVIDER_STATUSES);
