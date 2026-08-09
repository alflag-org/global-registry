import { z } from 'zod';
import { ACTOR_ROLES } from '../models/global-registry';
import { canonicalActorIdentitySchema } from './identity';

const actorIdSchema = z.string().min(1);
const actorDisplayNameSchema = z.string().trim().min(1).max(128);
const createActorInputShape = {
  identity: canonicalActorIdentitySchema,
  displayName: actorDisplayNameSchema,
  role: z.enum(ACTOR_ROLES),
};
const updateActorInputShape = {
  displayName: actorDisplayNameSchema.optional(),
  role: z.enum(ACTOR_ROLES).optional(),
  active: z.boolean().optional(),
  expectedRevision: z.number().int().positive(),
};
const hasMutableActorField = (input: {
  displayName?: string | undefined;
  role?: (typeof ACTOR_ROLES)[number] | undefined;
  active?: boolean | undefined;
}): boolean =>
  input.displayName !== undefined || input.role !== undefined || input.active !== undefined;

export const actorCreateInputSchema = z.object(createActorInputShape).strict();

export const actorUpdateInputSchema = z
  .object(updateActorInputShape)
  .strict()
  .refine(hasMutableActorField, {
    message: 'At least one mutable actor field is required.',
  });

export const createActorCommandSchema = z
  .object({
    ...createActorInputShape,
    actorId: actorIdSchema,
  })
  .strict();

export const updateActorCommandSchema = z
  .object({
    id: actorIdSchema,
    ...updateActorInputShape,
    actorId: actorIdSchema,
  })
  .strict()
  .refine(hasMutableActorField, {
    message: 'At least one mutable actor field is required.',
  });

export type CreateActorCommand = z.output<typeof createActorCommandSchema>;
export type UpdateActorCommand = z.output<typeof updateActorCommandSchema>;
