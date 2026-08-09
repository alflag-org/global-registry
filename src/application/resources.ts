import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import { violationsDetails } from '../domain/errors/violations';
import type {
  CreateResource,
  JsonObject,
  PolicyReference,
  PolicyVersion,
  ProfileVersion,
  Provider,
  ProviderBinding,
  Resource,
  ResourceKind,
  ResourceKindDefinitionVersion,
  UpdateResource,
  VersionedReference,
} from '../domain/models/global-registry';
import { evaluatePolicy } from '../domain/policy/evaluator';
import { evaluateProviderCompatibility } from '../domain/provider/compatibility';
import { materializeEffectiveSpec } from '../domain/resource/profile';
import {
  validatePlacement,
  validateResourceSpec,
  validateResourceSpecOverrides,
} from '../domain/resource/validation';

interface ResourceStore {
  getResource(key: string): Promise<Resource | null>;
  getResourceKindDefinition(
    key: string,
    version: number,
  ): Promise<ResourceKindDefinitionVersion | null>;
  getProfileVersion(key: string, version: number): Promise<ProfileVersion | null>;
  getPolicyVersion(namespace: string, key: string, version: number): Promise<PolicyVersion | null>;
  getBinding(resourceKey: string): Promise<ProviderBinding | null>;
  getProvider(id: string): Promise<Provider | null>;
  createResource(input: CreateResource): Promise<Resource>;
  updateResource(input: UpdateResource): Promise<Resource>;
}

interface CreateResourceCommand {
  actorId: string;
  key: string;
  kind: ResourceKind;
  kindVersion: number;
  name: string;
  placement: JsonObject;
  specOverrides: JsonObject;
  profile?: VersionedReference;
  policy?: PolicyReference;
}

interface UpdateResourceCommand {
  actorId: string;
  key: string;
  expectedRevision: number;
  name?: string;
  placement?: JsonObject;
  specOverrides?: JsonObject;
}

export class ResourceService {
  constructor(private readonly store: ResourceStore) {}

  async create(input: CreateResourceCommand): Promise<Resource> {
    const definition = await this.resolveDefinition(input.kind, input.kindVersion, true);
    const placement = validatePlacement(definition, input.placement);
    await this.validateLocationReference(definition, placement);
    const profile = await this.resolveProfile(input.profile, definition, true);
    const specOverrides = validateResourceSpecOverrides(definition, input.specOverrides);
    const spec = validateResourceSpec(
      definition,
      materializeEffectiveSpec(profile?.spec ?? null, specOverrides),
    );
    const policy = await this.resolvePolicy(input.policy, definition, true);
    const candidate = candidateResource({
      key: input.key,
      kind: input.kind,
      kindVersion: input.kindVersion,
      initialState: definition.initialState,
      name: input.name,
      placement,
      specOverrides,
      spec,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    });
    evaluateSelectedPolicy(candidate, policy, definition);
    return this.store.createResource({
      actorId: input.actorId,
      key: input.key,
      kind: input.kind,
      kindVersion: input.kindVersion,
      initialState: definition.initialState,
      name: input.name,
      placement,
      specOverrides,
      spec,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      ...(profile === null
        ? {}
        : {
            profileGuard: {
              expectedRevision: profile.revision,
              expectedStatus: profile.parentStatus,
            },
          }),
      ...(policy === null
        ? {}
        : {
            policyGuard: {
              expectedRevision: policy.revision,
              expectedStatus: policy.parentStatus,
            },
          }),
    });
  }

  async update(input: UpdateResourceCommand): Promise<Resource> {
    const current = await this.store.getResource(input.key);
    if (current === null) throw new NotFoundError('Resource', input.key);
    if (current.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Resource revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    if (
      input.name === undefined &&
      input.placement === undefined &&
      input.specOverrides === undefined
    ) {
      throw new ValidationError(
        'empty_resource_patch',
        'At least one mutable resource field is required.',
      );
    }

    const definition = await this.resolveDefinition(current.kind, current.kindVersion, false);
    const placement = validatePlacement(definition, input.placement ?? current.placement);
    await this.validateLocationReference(definition, placement);
    const profileReference = current.profile;
    const policyReference = current.policy;
    const profile = await this.resolveProfile(profileReference, definition, false);
    const specOverrides = validateResourceSpecOverrides(
      definition,
      input.specOverrides ?? current.specOverrides,
    );
    const spec = validateResourceSpec(
      definition,
      materializeEffectiveSpec(profile?.spec ?? null, specOverrides),
    );
    const policy = await this.resolvePolicy(policyReference, definition, false);
    const candidate: Resource = {
      id: current.id,
      key: current.key,
      kind: current.kind,
      kindVersion: current.kindVersion,
      name: input.name ?? current.name,
      placement,
      specOverrides,
      spec,
      lifecycleState: current.lifecycleState,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...(profileReference === undefined ? {} : { profile: profileReference }),
      ...(policyReference === undefined ? {} : { policy: policyReference }),
    };
    evaluateSelectedPolicy(candidate, policy, definition);
    const boundProviderGuard = await this.validateExistingBinding(candidate, policy, definition);
    return this.store.updateResource({
      actorId: input.actorId,
      key: current.key,
      name: candidate.name,
      placement,
      specOverrides,
      spec,
      profile: profileReference ?? null,
      policy: policyReference ?? null,
      ...(boundProviderGuard === undefined ? {} : { boundProviderGuard }),
      expectedRevision: input.expectedRevision,
    });
  }

  private async resolveProfile(
    reference: VersionedReference | undefined,
    definition: ResourceKindDefinitionVersion,
    requireActive: boolean,
  ): Promise<ProfileVersion | null> {
    if (reference === undefined) return null;
    const profile = await this.store.getProfileVersion(reference.key, reference.version);
    if (profile === null) {
      throw new NotFoundError('Profile version', `${reference.key}@${reference.version}`);
    }
    if (
      profile.resourceKind !== definition.key ||
      profile.resourceKindVersion !== definition.version
    ) {
      throw new ValidationError(
        'profile_kind_mismatch',
        'A resource profile must match the resource kind.',
        {
          profileKey: profile.key,
          profileKind: profile.resourceKind,
          resourceKind: definition.key,
          resourceKindVersion: definition.version,
        },
      );
    }
    if (requireActive && profile.parentStatus !== 'active') {
      throw new ConflictError('profile_not_active', 'New references require an active profile.', {
        profileKey: profile.key,
        status: profile.parentStatus,
      });
    }
    validateResourceSpecOverrides(definition, profile.spec);
    return profile;
  }

  private async resolvePolicy(
    reference: PolicyReference | undefined,
    definition: ResourceKindDefinitionVersion,
    requireActive: boolean,
  ): Promise<PolicyVersion | null> {
    if (reference === undefined) return null;
    const policy = await this.store.getPolicyVersion(
      reference.namespace,
      reference.key,
      reference.version,
    );
    if (policy === null) {
      throw new NotFoundError(
        'Policy version',
        `${reference.namespace}/${reference.key}@${reference.version}`,
      );
    }
    if (
      policy.resourceKind !== definition.key ||
      policy.resourceKindVersion !== definition.version
    ) {
      throw new ValidationError(
        'policy_kind_mismatch',
        'A resource policy must match the Resource kind definition version.',
        {
          policyKind: policy.resourceKind,
          policyKindVersion: policy.resourceKindVersion,
          resourceKind: definition.key,
          resourceKindVersion: definition.version,
        },
      );
    }
    if (requireActive && policy.parentStatus !== 'active') {
      throw new ConflictError('policy_not_active', 'New references require an active policy.', {
        namespace: policy.namespace,
        policyKey: policy.key,
        status: policy.parentStatus,
      });
    }
    return policy;
  }

  private async validateLocationReference(
    definition: ResourceKindDefinitionVersion,
    placement: JsonObject,
  ): Promise<void> {
    const locationKey =
      typeof placement.locationKey === 'string' ? placement.locationKey : undefined;
    if (definition.placementMode === 'root' || locationKey === undefined) return;
    const location = await this.store.getResource(locationKey);
    if (location === null) throw new NotFoundError('Placement-root Resource', locationKey);
    const locationDefinition = await this.resolveDefinition(
      location.kind,
      location.kindVersion,
      false,
    );
    if (locationDefinition.placementMode !== 'root') {
      throw new ValidationError(
        'placement_location_kind_mismatch',
        'placement.locationKey must reference a placement-root Resource.',
        { locationKey, actualKind: location.kind },
      );
    }
  }

  private async validateExistingBinding(
    resource: Resource,
    policy: PolicyVersion | null,
    definition: ResourceKindDefinitionVersion,
  ): Promise<{ providerId: string; expectedRevision: number } | undefined> {
    const binding = await this.store.getBinding(resource.key);
    if (binding === null) return undefined;
    const provider = await this.store.getProvider(binding.providerId);
    if (provider === null) throw new NotFoundError('Provider', binding.providerId);
    const compatibility = evaluateProviderCompatibility({
      resource,
      provider,
      definition,
      requireActive: false,
    });
    if (!compatibility.valid) {
      throw new ValidationError(
        'provider_incompatible',
        'The resource update would invalidate its provider binding.',
        violationsDetails(compatibility.violations),
      );
    }
    if (policy !== null) evaluateSelectedPolicy(resource, policy, definition, provider, binding);
    return { providerId: provider.id, expectedRevision: provider.revision };
  }

  private async resolveDefinition(
    key: string,
    version: number,
    requireActive: boolean,
  ): Promise<ResourceKindDefinitionVersion> {
    const definition = await this.store.getResourceKindDefinition(key, version);
    if (definition === null) {
      throw new NotFoundError('Resource kind definition', `${key}@${version}`);
    }
    if (requireActive && definition.parentStatus !== 'active') {
      throw new ConflictError(
        'resource_kind_definition_not_active',
        'New Resources require an active Resource kind definition.',
        { key, version, status: definition.parentStatus },
      );
    }
    return definition;
  }
}

function candidateResource(input: {
  key: string;
  kind: ResourceKind;
  kindVersion: number;
  initialState: string;
  name: string;
  placement: JsonObject;
  specOverrides: JsonObject;
  spec: JsonObject;
  profile?: VersionedReference;
  policy?: PolicyReference;
}): Resource {
  const timestamp = new Date(0).toISOString();
  return {
    id: 'candidate',
    key: input.key,
    kind: input.kind,
    kindVersion: input.kindVersion,
    name: input.name,
    placement: input.placement,
    specOverrides: input.specOverrides,
    spec: input.spec,
    lifecycleState: input.initialState,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  };
}

function evaluateSelectedPolicy(
  resource: Resource,
  policy: PolicyVersion | null,
  definition: ResourceKindDefinitionVersion,
  provider?: Provider,
  binding?: ProviderBinding,
): void {
  if (policy === null) return;
  const result = evaluatePolicy({
    resource,
    policy,
    definition,
    ...(provider === undefined ? {} : { provider }),
    ...(binding === undefined ? {} : { binding }),
  });
  if (!result.valid) {
    throw new ValidationError(
      'policy_violation',
      'The resource violates the selected policy.',
      violationsDetails(result.violations),
    );
  }
}
