import { z } from 'zod';
import { RELATIONSHIP_TYPES } from '../models/global-registry';
import { MAX_OPERATION_CHANGES } from './limits';

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');
const identifierSchema = z.string().trim().min(1).max(256);

export const operationChangeSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('binding.replace'),
      resourceKey: stableKeySchema,
      providerId: stableKeySchema,
      providerResourceType: identifierSchema,
      providerResourceId: identifierSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('binding.remove'),
      resourceKey: stableKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('relationship.create'),
      resourceKey: stableKeySchema,
      targetResourceKey: stableKeySchema,
      relationshipType: z.enum(RELATIONSHIP_TYPES),
    })
    .strict(),
  z
    .object({
      action: z.literal('relationship.remove'),
      resourceKey: stableKeySchema,
      relationshipId: identifierSchema,
    })
    .strict(),
]);

export const operationChangesSchema = z.array(operationChangeSchema).max(MAX_OPERATION_CHANGES);
