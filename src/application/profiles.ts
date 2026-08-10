import { ConflictError, ValidationError } from '../domain/errors/global-registry-error';
import type {
  JsonObject,
  ProfileVersion,
  ResourceKind,
  ResourceKindDefinitionVersion,
  VersionParentStatus,
} from '../domain/models/global-registry';
import { validateResourceSpecOverrides } from '../domain/resource/validation';

export interface ProfileSummary {
  key: string;
  resourceKind: ResourceKind;
  resourceKindVersion: number;
  version: number;
  status: VersionParentStatus;
  revision: number;
}

interface ProfileStore {
  getResourceKindDefinition(
    key: string,
    version: number,
  ): Promise<ResourceKindDefinitionVersion | null>;
  getProfileSummary(key: string): Promise<ProfileSummary | null>;
  createProfileVersion(input: {
    key: string;
    resourceKind: ResourceKind;
    resourceKindVersion: number;
    spec: JsonObject;
    actorId: string;
    expectedRevision?: number;
  }): Promise<ProfileVersion>;
  updateProfileStatus(input: {
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<ProfileSummary>;
}

export class ProfileService {
  constructor(private readonly store: ProfileStore) {}

  async createVersion(input: {
    key: string;
    resourceKind: ResourceKind;
    resourceKindVersion: number;
    spec: JsonObject;
    actorId: string;
    expectedRevision?: number;
  }): Promise<ProfileVersion> {
    const definition = await this.store.getResourceKindDefinition(
      input.resourceKind,
      input.resourceKindVersion,
    );
    if (definition === null) {
      throw new ValidationError(
        'resource_kind_definition_not_found',
        'The referenced Resource kind definition does not exist.',
      );
    }
    if (definition.parentStatus !== 'active') {
      throw new ConflictError(
        'resource_kind_definition_not_active',
        'New Profile versions require an active Resource kind definition.',
        { key: definition.key, version: definition.version, status: definition.parentStatus },
      );
    }
    const current = await this.store.getProfileSummary(input.key);
    if (current === null && input.expectedRevision !== undefined) {
      throw new ConflictError(
        'profile_not_created',
        'The profile does not exist at the expected revision.',
        { key: input.key, expectedRevision: input.expectedRevision },
      );
    }
    if (current !== null) {
      if (input.expectedRevision === undefined) {
        throw new ValidationError(
          'expected_revision_required',
          'Profile version updates require expectedRevision.',
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ConflictError('revision_conflict', 'Profile revision is stale.', {
          key: input.key,
          expectedRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      if (current.status !== 'active') {
        throw new ConflictError(
          'profile_not_active',
          'New profile versions require an active profile.',
          { key: input.key, status: current.status },
        );
      }
      if (
        current.resourceKind !== input.resourceKind ||
        current.resourceKindVersion !== input.resourceKindVersion
      ) {
        throw new ValidationError(
          'profile_kind_immutable',
          'A profile cannot change resource kind.',
        );
      }
    }
    const spec = validateResourceSpecOverrides(definition, input.spec);
    return this.store.createProfileVersion({ ...input, spec });
  }

  async updateStatus(input: {
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<ProfileSummary> {
    const current = await this.store.getProfileSummary(input.key);
    if (current === null) {
      throw new ConflictError('profile_not_created', 'The profile does not exist.', {
        key: input.key,
      });
    }
    assertParentStatusTransition('profile', current.status, input.status);
    return this.store.updateProfileStatus(input);
  }
}

export function assertParentStatusTransition(
  entity: 'profile' | 'policy' | 'Resource kind definition',
  current: VersionParentStatus,
  target: VersionParentStatus,
): void {
  if (current === 'retired' && target !== 'retired') {
    throw new ConflictError(
      `${entity.toLowerCase().replaceAll(' ', '_')}_retired`,
      `A retired ${entity} cannot return to another status.`,
    );
  }
  if (current === target) {
    throw new ConflictError(
      `${entity.toLowerCase().replaceAll(' ', '_')}_status_unchanged`,
      `The ${entity} already has status ${target}.`,
    );
  }
}
