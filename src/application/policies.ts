import { ConflictError, ValidationError } from '../domain/errors/global-registry-error';
import type {
  JsonObject,
  PolicyVersion,
  ResourceKind,
  ResourceKindDefinitionVersion,
  VersionParentStatus,
} from '../domain/models/global-registry';
import { validatePolicyDefinition } from '../domain/policy/validation';
import { assertParentStatusTransition } from './profiles';

export interface PolicySummary {
  namespace: string;
  key: string;
  resourceKind: ResourceKind;
  resourceKindVersion: number;
  version: number;
  status: VersionParentStatus;
  revision: number;
}

interface PolicyStore {
  getResourceKindDefinition(
    key: string,
    version: number,
  ): Promise<ResourceKindDefinitionVersion | null>;
  getPolicySummary(namespace: string, key: string): Promise<PolicySummary | null>;
  createPolicyVersion(input: {
    namespace: string;
    key: string;
    resourceKind: ResourceKind;
    resourceKindVersion: number;
    spec: JsonObject;
    actorId: string;
    expectedRevision?: number;
  }): Promise<PolicyVersion>;
  updatePolicyStatus(input: {
    namespace: string;
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<PolicySummary>;
}

export class PolicyService {
  constructor(private readonly store: PolicyStore) {}

  async createVersion(input: {
    namespace: string;
    key: string;
    resourceKind: ResourceKind;
    resourceKindVersion: number;
    spec: JsonObject;
    actorId: string;
    expectedRevision?: number;
  }): Promise<PolicyVersion> {
    const resourceKindDefinition = await this.store.getResourceKindDefinition(
      input.resourceKind,
      input.resourceKindVersion,
    );
    if (resourceKindDefinition === null) {
      throw new ValidationError(
        'resource_kind_definition_not_found',
        'The referenced Resource kind definition does not exist.',
      );
    }
    if (resourceKindDefinition.parentStatus !== 'active') {
      throw new ConflictError(
        'resource_kind_definition_not_active',
        'New Policy versions require an active Resource kind definition.',
        {
          key: resourceKindDefinition.key,
          version: resourceKindDefinition.version,
          status: resourceKindDefinition.parentStatus,
        },
      );
    }
    const definition = validatePolicyDefinition(
      {
        namespace: input.namespace,
        key: input.key,
        resourceKind: input.resourceKind,
        resourceKindVersion: input.resourceKindVersion,
        spec: input.spec,
      },
      resourceKindDefinition,
    );
    const current = await this.store.getPolicySummary(input.namespace, input.key);
    if (current === null && input.expectedRevision !== undefined) {
      throw new ConflictError(
        'policy_not_created',
        'The policy does not exist at the expected revision.',
        {
          namespace: input.namespace,
          key: input.key,
          expectedRevision: input.expectedRevision,
        },
      );
    }
    if (current !== null) {
      if (input.expectedRevision === undefined) {
        throw new ValidationError(
          'expected_revision_required',
          'Policy version updates require expectedRevision.',
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ConflictError('revision_conflict', 'Policy revision is stale.', {
          namespace: input.namespace,
          key: input.key,
          expectedRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      if (current.status !== 'active') {
        throw new ConflictError(
          'policy_not_active',
          'New policy versions require an active policy.',
          { namespace: input.namespace, key: input.key, status: current.status },
        );
      }
      if (
        current.resourceKind !== input.resourceKind ||
        current.resourceKindVersion !== input.resourceKindVersion
      ) {
        throw new ValidationError('policy_kind_immutable', 'A policy cannot change resource kind.');
      }
    }
    return this.store.createPolicyVersion({
      ...input,
      resourceKind: definition.resourceKind,
      resourceKindVersion: definition.resourceKindVersion,
      spec: definition.spec,
    });
  }

  async updateStatus(input: {
    namespace: string;
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<PolicySummary> {
    const current = await this.store.getPolicySummary(input.namespace, input.key);
    if (current === null) {
      throw new ConflictError('policy_not_created', 'The policy does not exist.', {
        namespace: input.namespace,
        key: input.key,
      });
    }
    assertParentStatusTransition('policy', current.status, input.status);
    return this.store.updatePolicyStatus(input);
  }
}
