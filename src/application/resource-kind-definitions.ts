import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import type {
  ResourceKindDefinitionVersion,
  ResourceSpecificationMode,
  VersionParentStatus,
} from '../domain/models/global-registry';
import type { ResourceKindDefinitionInput } from '../domain/resource-kind/schemas';
import { validateResourceKindDefinition } from '../domain/resource-kind/validation';
import { assertParentStatusTransition } from './profiles';

export interface ResourceKindDefinitionSummary {
  key: string;
  version: number;
  status: VersionParentStatus;
  revision: number;
}

export interface CreateResourceKindDefinitionInput extends ResourceKindDefinitionInput {
  actorId: string;
  expectedRevision?: number;
}

export interface PersistResourceKindDefinitionInput extends CreateResourceKindDefinitionInput {
  specificationMode: ResourceSpecificationMode;
}

interface ResourceKindDefinitionStore {
  getResourceKindDefinition(
    key: string,
    version: number,
  ): Promise<ResourceKindDefinitionVersion | null>;
  getResourceKindDefinitionSummary(key: string): Promise<ResourceKindDefinitionSummary | null>;
  listResourceKindDefinitions(limit?: number): Promise<ResourceKindDefinitionSummary[]>;
  createResourceKindDefinitionVersion(
    input: PersistResourceKindDefinitionInput,
  ): Promise<ResourceKindDefinitionVersion>;
  updateResourceKindDefinitionStatus(input: {
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<ResourceKindDefinitionSummary>;
}

export class ResourceKindDefinitionService {
  constructor(private readonly store: ResourceKindDefinitionStore) {}

  async createVersion(
    input: CreateResourceKindDefinitionInput,
  ): Promise<ResourceKindDefinitionVersion> {
    const definition = validateResourceKindDefinition({
      key: input.key,
      states: input.states,
      initialState: input.initialState,
      terminalStates: input.terminalStates,
      transitions: input.transitions,
      placementMode: input.placementMode,
      relationshipRules: input.relationshipRules,
    });
    const current = await this.store.getResourceKindDefinitionSummary(input.key);
    if (current === null && input.expectedRevision !== undefined) {
      throw new ConflictError(
        'resource_kind_definition_not_created',
        'The Resource kind definition does not exist at the expected revision.',
        { key: input.key, expectedRevision: input.expectedRevision },
      );
    }
    if (current !== null) {
      if (input.expectedRevision === undefined) {
        throw new ValidationError(
          'expected_revision_required',
          'Resource kind definition updates require expectedRevision.',
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ConflictError(
          'revision_conflict',
          'Resource kind definition revision is stale.',
          {
            key: input.key,
            expectedRevision: input.expectedRevision,
            currentRevision: current.revision,
          },
        );
      }
      if (current.status !== 'active') {
        throw new ConflictError(
          'resource_kind_definition_not_active',
          'New definition versions require an active Resource kind definition.',
          { key: input.key, status: current.status },
        );
      }
    }

    const referencedKinds = new Set(
      definition.relationshipRules.flatMap((rule) => rule.targetKinds),
    );
    referencedKinds.delete('*');
    referencedKinds.delete(definition.key);
    for (const targetKind of referencedKinds) {
      const target = await this.store.getResourceKindDefinitionSummary(targetKind);
      if (target === null) throw new NotFoundError('Resource kind definition', targetKind);
      if (target.status !== 'active') {
        throw new ConflictError(
          'resource_kind_definition_not_active',
          'New relationship rules require active target Resource kind definitions.',
          { key: targetKind, status: target.status },
        );
      }
    }

    return this.store.createResourceKindDefinitionVersion({
      ...definition,
      actorId: input.actorId,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    });
  }

  async updateStatus(input: {
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<ResourceKindDefinitionSummary> {
    const current = await this.store.getResourceKindDefinitionSummary(input.key);
    if (current === null) {
      throw new ConflictError(
        'resource_kind_definition_not_created',
        'The Resource kind definition does not exist.',
        { key: input.key },
      );
    }
    assertParentStatusTransition('Resource kind definition', current.status, input.status);
    return this.store.updateResourceKindDefinitionStatus(input);
  }
}
