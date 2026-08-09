import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import { violationsDetails, zodViolations } from '../domain/errors/violations';
import type { Actor } from '../domain/models/global-registry';
import {
  createActorCommandSchema,
  type CreateActorCommand,
  updateActorCommandSchema,
  type UpdateActorCommand,
} from '../domain/actor/schemas';

interface ActorStore {
  getActor(id: string): Promise<Actor | null>;
  createActor(input: CreateActorCommand): Promise<Actor>;
  updateActor(input: UpdateActorCommand): Promise<Actor>;
}

export class ActorService {
  constructor(private readonly store: ActorStore) {}

  create(input: CreateActorCommand): Promise<Actor> {
    const result = createActorCommandSchema.safeParse(input);
    if (!result.success) {
      throw new ValidationError(
        'invalid_actor_create',
        'Actor creation input is invalid.',
        violationsDetails(zodViolations(result.error)),
      );
    }
    return this.store.createActor(result.data);
  }

  async update(input: UpdateActorCommand): Promise<Actor> {
    const result = updateActorCommandSchema.safeParse(input);
    if (!result.success) {
      const hasMutableField =
        input.displayName !== undefined || input.role !== undefined || input.active !== undefined;
      throw new ValidationError(
        hasMutableField ? 'invalid_actor_update' : 'empty_actor_patch',
        hasMutableField
          ? 'Actor update input is invalid.'
          : 'At least one mutable actor field is required.',
        violationsDetails(zodViolations(result.error)),
      );
    }

    const current = await this.store.getActor(result.data.id);
    if (current === null) throw new NotFoundError('Actor', result.data.id);
    if (current.revision !== result.data.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Actor revision is stale.', {
        id: result.data.id,
        expectedRevision: result.data.expectedRevision,
        currentRevision: current.revision,
      });
    }
    return this.store.updateActor(result.data);
  }
}
