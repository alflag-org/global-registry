import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import type {
  Operation,
  RelationshipType,
  Resource,
  ResourceRelationship,
} from '../domain/models/global-registry';
import { assertRunningOperationChange } from '../domain/operation/validation';
import { validateRelationshipKinds } from '../domain/resource/relationships';

interface CreateRelationshipCommand {
  sourceKey: string;
  targetKey: string;
  relationshipType: RelationshipType;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

interface RemoveRelationshipCommand {
  id: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

interface RelationshipStore {
  getResource(key: string): Promise<Resource | null>;
  getResourceById(id: string): Promise<Resource | null>;
  getOperation(id: string): Promise<Operation | null>;
  getRelationship(id: string): Promise<ResourceRelationship | null>;
  createRelationship(input: CreateRelationshipCommand): Promise<ResourceRelationship>;
  removeRelationship(input: RemoveRelationshipCommand): Promise<void>;
}

export class RelationshipService {
  constructor(private readonly store: RelationshipStore) {}

  async create(input: CreateRelationshipCommand): Promise<ResourceRelationship> {
    const [source, target, operation] = await Promise.all([
      this.store.getResource(input.sourceKey),
      this.store.getResource(input.targetKey),
      this.store.getOperation(input.operationId),
    ]);
    if (source === null) throw new NotFoundError('Resource', input.sourceKey);
    if (target === null) throw new NotFoundError('Resource', input.targetKey);
    if (operation === null) throw new NotFoundError('Operation', input.operationId);
    if (source.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Source resource revision is stale.', {
        key: source.key,
        expectedRevision: input.expectedRevision,
        currentRevision: source.revision,
      });
    }
    if (source.id === target.id) {
      throw new ValidationError(
        'self_relationship_forbidden',
        'A resource cannot have a relationship to itself.',
      );
    }
    if (source.lifecycleState === 'retired') {
      throw new ConflictError(
        'resource_retired',
        'A retired resource cannot receive new relationships.',
        { resourceKey: source.key },
      );
    }
    validateRelationshipKinds(source.kind, input.relationshipType, target.kind);
    assertRunningOperationChange(operation, {
      action: 'relationship.create',
      resourceKey: source.key,
      targetResourceKey: target.key,
      relationshipType: input.relationshipType,
    });
    return this.store.createRelationship(input);
  }

  async remove(input: RemoveRelationshipCommand): Promise<void> {
    const relationship = await this.store.getRelationship(input.id);
    if (relationship === null) throw new NotFoundError('Relationship', input.id);
    const [source, operation] = await Promise.all([
      this.store.getResourceById(relationship.sourceResourceId),
      this.store.getOperation(input.operationId),
    ]);
    if (source === null) throw new NotFoundError('Resource', relationship.sourceResourceId);
    if (operation === null) throw new NotFoundError('Operation', input.operationId);
    if (relationship.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Relationship revision is stale.', {
        id: relationship.id,
        expectedRevision: input.expectedRevision,
        currentRevision: relationship.revision,
      });
    }
    if (source.lifecycleState !== 'retired') {
      throw new ConflictError(
        'relationship_removal_lifecycle_conflict',
        'A relationship can be removed only after its source resource is retired.',
        { resourceKey: source.key, lifecycleState: source.lifecycleState },
      );
    }
    assertRunningOperationChange(operation, {
      action: 'relationship.remove',
      resourceKey: source.key,
      relationshipId: relationship.id,
    });
    await this.store.removeRelationship(input);
  }
}
