import { z } from 'zod';
import { RELATIONSHIP_TYPES, RESOURCE_PLACEMENT_MODES } from '../models/global-registry';
import { hasUniqueValues } from '../unique-values';

export const resourceKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Use lowercase segments separated by dots, underscores, or hyphens.',
  );

export const resourceLifecycleStateSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Use lowercase segments separated by dots, underscores, or hyphens.',
  );

const targetKindSchema = z.union([resourceKindSchema, z.literal('*')]);

export const resourceLifecycleTransitionSchema = z
  .object({
    from: resourceLifecycleStateSchema,
    to: resourceLifecycleStateSchema,
    destructive: z.boolean(),
  })
  .strict();

export const resourceKindRelationshipRuleSchema = z
  .object({
    relationshipType: z.enum(RELATIONSHIP_TYPES),
    targetKinds: z
      .array(targetKindSchema)
      .min(1)
      .max(64)
      .refine(hasUniqueValues, 'Target kinds must be unique.'),
  })
  .strict();

export const resourceKindDefinitionInputSchema = z
  .object({
    key: resourceKindSchema,
    states: z
      .array(resourceLifecycleStateSchema)
      .min(1)
      .max(64)
      .refine(hasUniqueValues, 'Lifecycle states must be unique.'),
    initialState: resourceLifecycleStateSchema,
    terminalStates: z
      .array(resourceLifecycleStateSchema)
      .min(1)
      .max(64)
      .refine(hasUniqueValues, 'Terminal states must be unique.'),
    transitions: z.array(resourceLifecycleTransitionSchema).max(256),
    placementMode: z.enum(RESOURCE_PLACEMENT_MODES),
    relationshipRules: z.array(resourceKindRelationshipRuleSchema).max(64),
  })
  .strict();

export type ResourceKindDefinitionInput = z.output<typeof resourceKindDefinitionInputSchema>;
