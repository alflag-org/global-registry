import { GlobalRegistryError } from '../domain/errors/global-registry-error';
import { ensureJsonObject } from '../domain/models/json';
import type { DomainViolation } from '../domain/errors/violations';
import { zodViolations } from '../domain/errors/violations';
import type {
  JsonObject,
  JsonValue,
  PolicyVersion,
  ProfileVersion,
  Provider,
  ProviderBinding,
  Resource,
  ResourceRelationship,
} from '../domain/models/global-registry';
import { evaluatePolicy } from '../domain/policy/evaluator';
import { validatePolicyDefinition } from '../domain/policy/validation';
import { evaluateProviderCompatibility } from '../domain/provider/compatibility';
import { validateProviderDefinition } from '../domain/provider/validation';
import { materializeEffectiveSpec } from '../domain/resource/profile';
import { validateRelationshipKinds } from '../domain/resource/relationships';
import {
  validatePlacement,
  validateResourceSpec,
  validateResourceSpecOverrides,
} from '../domain/resource/validation';
import { registrySnapshotSchema, type PortableRegistrySnapshot } from './registry-snapshot';
import { MAX_OUTBOX_CONSUMER_ATTEMPTS, MAX_OUTBOX_PRODUCER_ATTEMPTS } from './limits';

export type RegistrySnapshot = PortableRegistrySnapshot;

interface DomainRegistrySnapshot {
  resources: Resource[];
  providers: Provider[];
  profiles: ProfileVersion[];
  policies: PolicyVersion[];
  bindings: ProviderBinding[];
  relationships: ResourceRelationship[];
}

interface RegistryViolation extends DomainViolation {
  entity: string;
  key: string;
  currentValue?: JsonValue;
}

interface RegistryValidationReport {
  valid: boolean;
  counts: {
    resources: number;
    providers: number;
    profiles: number;
    policies: number;
    bindings: number;
    relationships: number;
  };
  violations: RegistryViolation[];
}

export function validateRegistrySnapshot(value: unknown): RegistryValidationReport {
  const parsed = registrySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const violations = zodViolations(parsed.error).map((violation) => ({
      ...violation,
      entity: 'snapshot' as const,
      key: 'snapshot',
      ...currentValueAt(value, violation.path),
    }));
    return report(emptyCounts(), violations);
  }
  const portableSnapshot = parsed.data as PortableRegistrySnapshot;
  const violations: RegistryViolation[] = [];
  validatePortableSnapshotInvariants(portableSnapshot, violations);
  const snapshot = toDomainRegistrySnapshot(portableSnapshot, violations);
  const resourcesById = uniqueMap(
    snapshot.resources,
    (resource) => resource.id,
    'resource',
    'id',
    violations,
  );
  const resourcesByKey = uniqueMap(
    snapshot.resources,
    (resource) => resource.key,
    'resource',
    'key',
    violations,
  );
  const providersById = uniqueMap(
    snapshot.providers,
    (provider) => provider.id,
    'provider',
    'id',
    violations,
  );
  const profilesByReference = uniqueMap(
    snapshot.profiles,
    (profile) => `${profile.key}@${profile.version}`,
    'profile',
    'version',
    violations,
  );
  const policiesByReference = uniqueMap(
    snapshot.policies,
    (policy) => `${policy.namespace}/${policy.key}@${policy.version}`,
    'policy',
    'version',
    violations,
  );

  for (const profile of snapshot.profiles) {
    capture(violations, 'profile', `${profile.key}@${profile.version}`, profile, () => {
      ensureJsonObject(profile.spec, `profile ${profile.key} spec`);
      validateResourceSpecOverrides(profile.resourceKind, profile.spec);
    });
  }

  for (const policy of snapshot.policies) {
    capture(
      violations,
      'policy',
      `${policy.namespace}/${policy.key}@${policy.version}`,
      policy,
      () => {
        ensureJsonObject(policy.spec, `policy ${policy.namespace}/${policy.key} spec`);
        validatePolicyDefinition({
          namespace: policy.namespace,
          key: policy.key,
          resourceKind: policy.resourceKind,
          spec: policy.spec,
        });
      },
    );
  }

  for (const provider of snapshot.providers) {
    capture(violations, 'provider', provider.id, provider, () => {
      ensureJsonObject(provider.capabilities, `provider ${provider.id} capabilities`);
      ensureJsonObject(provider.configuration, `provider ${provider.id} configuration`);
      ensureJsonObject(provider.mappings, `provider ${provider.id} mappings`);
      validateProviderDefinition({
        id: provider.id,
        driver: provider.driver,
        credentialRef: provider.credentialRef,
        status: provider.status,
        capabilities: provider.capabilities,
        configuration: provider.configuration,
        mappings: provider.mappings,
      });
    });
  }

  for (const resource of snapshot.resources) {
    capture(violations, 'resource', resource.key, resource, () => {
      ensureJsonObject(resource.placement, `resource ${resource.key} placement`);
      ensureJsonObject(resource.specOverrides, `resource ${resource.key} spec overrides`);
      ensureJsonObject(resource.spec, `resource ${resource.key} effective spec`);
      const placement = validatePlacement(resource.kind, resource.placement);
      const overrides = validateResourceSpecOverrides(resource.kind, resource.specOverrides);
      validateResourceSpec(resource.kind, resource.spec);

      const locationKey =
        typeof placement.locationKey === 'string' ? placement.locationKey : undefined;
      if (locationKey !== undefined) {
        const location = resourcesByKey.get(locationKey);
        if (location === undefined) {
          addViolation(
            violations,
            'resource',
            resource.key,
            'location_not_found',
            'placement.locationKey',
            `Location resource ${locationKey} does not exist.`,
            locationKey,
          );
        } else if (location.kind !== 'location') {
          addViolation(
            violations,
            'resource',
            resource.key,
            'placement_location_kind_mismatch',
            'placement.locationKey',
            `${locationKey} is ${location.kind}, not location.`,
            locationKey,
          );
        }
      }

      const profile =
        resource.profile === undefined
          ? undefined
          : profilesByReference.get(`${resource.profile.key}@${resource.profile.version}`);
      if (resource.profile !== undefined && profile === undefined) {
        addViolation(
          violations,
          'resource',
          resource.key,
          'profile_not_found',
          'profile',
          `Profile ${resource.profile.key}@${resource.profile.version} does not exist.`,
          { key: resource.profile.key, version: resource.profile.version },
        );
      }
      if (
        resource.profile !== undefined &&
        profile !== undefined &&
        profile.resourceKind !== resource.kind
      ) {
        addViolation(
          violations,
          'resource',
          resource.key,
          'profile_kind_mismatch',
          'profile',
          `Profile kind ${profile.resourceKind} does not match ${resource.kind}.`,
          { key: resource.profile.key, version: resource.profile.version },
        );
      }
      const effective = materializeEffectiveSpec(profile?.spec ?? null, overrides);
      if (!jsonEqual(effective, resource.spec)) {
        addViolation(
          violations,
          'resource',
          resource.key,
          'effective_spec_mismatch',
          'spec',
          'Stored effective spec does not equal profile defaults merged with specOverrides.',
          resource.spec,
        );
      }

      if (resource.policy !== undefined) {
        const policy = policiesByReference.get(
          `${resource.policy.namespace}/${resource.policy.key}@${resource.policy.version}`,
        );
        if (policy === undefined) {
          addViolation(
            violations,
            'resource',
            resource.key,
            'policy_not_found',
            'policy',
            `Policy ${resource.policy.namespace}/${resource.policy.key}@${resource.policy.version} does not exist.`,
            {
              namespace: resource.policy.namespace,
              key: resource.policy.key,
              version: resource.policy.version,
            },
          );
        } else {
          appendEvaluation(
            violations,
            'resource',
            resource.key,
            resource,
            evaluatePolicy({ resource, policy }).violations,
          );
        }
      }
    });
  }

  const providerResourceTuples = new Set<string>();
  const bindingResourceIds = new Set<string>();
  const providerBindingCounts = new Map<string, number>();
  for (const binding of snapshot.bindings) {
    const bindingKey = `${binding.providerId}/${binding.providerResourceType}/${binding.providerResourceId}`;
    if (bindingResourceIds.has(binding.resourceId)) {
      addViolation(
        violations,
        'binding',
        bindingKey,
        'duplicate_resource_binding',
        'resourceId',
        `Resource ${binding.resourceId} has more than one active binding.`,
        binding.resourceId,
      );
    }
    bindingResourceIds.add(binding.resourceId);
    if (providerResourceTuples.has(bindingKey)) {
      addViolation(
        violations,
        'binding',
        bindingKey,
        'duplicate_provider_resource_tuple',
        'providerResourceId',
        'Provider resource tuples must be globally unique.',
        binding.providerResourceId,
      );
    }
    providerResourceTuples.add(bindingKey);
    providerBindingCounts.set(
      binding.providerId,
      (providerBindingCounts.get(binding.providerId) ?? 0) + 1,
    );

    const resource = resourcesById.get(binding.resourceId);
    const provider = providersById.get(binding.providerId);
    if (resource === undefined) {
      addViolation(
        violations,
        'binding',
        bindingKey,
        'resource_not_found',
        'resourceId',
        `Resource ${binding.resourceId} does not exist.`,
        binding.resourceId,
      );
    }
    if (provider === undefined) {
      addViolation(
        violations,
        'binding',
        bindingKey,
        'provider_not_found',
        'providerId',
        `Provider ${binding.providerId} does not exist.`,
        binding.providerId,
      );
    }
    if (resource === undefined || provider === undefined) continue;

    capture(violations, 'binding', bindingKey, binding, () => {
      ensureJsonObject(binding.locator, `binding ${bindingKey} locator`);
      appendEvaluation(
        violations,
        'binding',
        bindingKey,
        binding,
        evaluateProviderCompatibility({
          resource,
          provider,
          requireActive: false,
        }).violations,
      );
      if (resource.policy !== undefined) {
        const policy = policiesByReference.get(
          `${resource.policy.namespace}/${resource.policy.key}@${resource.policy.version}`,
        );
        if (policy !== undefined) {
          appendEvaluation(
            violations,
            'binding',
            bindingKey,
            binding,
            evaluatePolicy({ resource, policy, provider, binding }).violations,
          );
        }
      }
    });
  }

  for (const provider of snapshot.providers) {
    if (provider.status === 'retired' && (providerBindingCounts.get(provider.id) ?? 0) > 0) {
      addViolation(
        violations,
        'provider',
        provider.id,
        'provider_has_active_bindings',
        'status',
        'A retired provider cannot retain active bindings.',
        provider.status,
      );
    }
  }

  const relationshipTuples = new Set<string>();
  for (const relationship of snapshot.relationships) {
    const source = resourcesById.get(relationship.sourceResourceId);
    const target = resourcesById.get(relationship.targetResourceId);
    if (source === undefined || target === undefined) {
      addViolation(
        violations,
        'relationship',
        relationship.id,
        'relationship_resource_not_found',
        source === undefined ? 'sourceResourceId' : 'targetResourceId',
        'Relationship source and target resources must exist.',
        source === undefined ? relationship.sourceResourceId : relationship.targetResourceId,
      );
      continue;
    }
    const tuple = `${source.id}/${relationship.relationshipType}/${target.id}`;
    if (relationshipTuples.has(tuple)) {
      addViolation(
        violations,
        'relationship',
        relationship.id,
        'duplicate_relationship',
        'relationshipType',
        'Relationship tuples must be unique.',
        relationship.relationshipType,
      );
    }
    relationshipTuples.add(tuple);
    if (source.id === target.id) {
      addViolation(
        violations,
        'relationship',
        relationship.id,
        'self_relationship_forbidden',
        'targetResourceId',
        'A resource cannot have a relationship to itself.',
        relationship.targetResourceId,
      );
      continue;
    }
    capture(violations, 'relationship', relationship.id, relationship, () => {
      validateRelationshipKinds(source.kind, relationship.relationshipType, target.kind);
    });
  }

  return report(
    {
      resources: snapshot.resources.length,
      providers: snapshot.providers.length,
      profiles: snapshot.profiles.length,
      policies: snapshot.policies.length,
      bindings: snapshot.bindings.length,
      relationships: snapshot.relationships.length,
    },
    violations,
  );
}

export function assertValidRegistrySnapshot(value: unknown): PortableRegistrySnapshot {
  const validation = validateRegistrySnapshot(value);
  if (!validation.valid) {
    const details = validation.violations
      .slice(0, 5)
      .map((violation) => `${violation.code}@${violation.path}`)
      .join(',');
    throw new Error(`export_snapshot_invalid:${details}`);
  }
  return value as PortableRegistrySnapshot;
}

function toDomainBinding(binding: PortableRegistrySnapshot['bindings'][number]): ProviderBinding {
  return {
    resourceId: binding.resourceId,
    providerId: binding.providerId,
    providerResourceType: binding.providerResourceType,
    providerResourceId: binding.providerResourceId,
    ...(binding.providerResourceName === undefined
      ? {}
      : { providerResourceName: binding.providerResourceName }),
    locator: binding.locator,
    boundAt: binding.boundAt,
    boundBy: binding.boundBy,
  };
}

function toDomainRegistrySnapshot(
  snapshot: PortableRegistrySnapshot,
  violations: RegistryViolation[],
): DomainRegistrySnapshot {
  const profilesByKey = uniqueMap(
    snapshot.profiles,
    (profile) => profile.key,
    'profile_parent',
    'key',
    violations,
  );
  const profileVersionsByReference = uniqueMap(
    snapshot.profileVersions,
    (profile) => `${profile.profileKey}@${profile.version}`,
    'profile_version',
    'version',
    violations,
  );
  const profiles: ProfileVersion[] = [];
  for (const profile of snapshot.profiles) {
    const reference = `${profile.key}@${profile.currentVersion}`;
    if (!profileVersionsByReference.has(reference)) {
      addViolation(
        violations,
        'profile_parent',
        profile.key,
        'current_version_not_found',
        'currentVersion',
        `Profile current version ${reference} is not present in profileVersions.`,
        profile.currentVersion,
      );
    }
  }
  for (const version of snapshot.profileVersions) {
    const parent = profilesByKey.get(version.profileKey);
    if (parent === undefined) {
      addViolation(
        violations,
        'profile_version',
        `${version.profileKey}@${version.version}`,
        'profile_parent_not_found',
        'profileKey',
        `Profile parent ${version.profileKey} does not exist.`,
        version.profileKey,
      );
      continue;
    }
    profiles.push({
      key: version.profileKey,
      version: version.version,
      resourceKind: parent.resourceKind,
      spec: version.spec as JsonObject,
      parentStatus: parent.status,
      revision: parent.revision,
      createdAt: version.createdAt,
    });
  }

  const policiesByReference = uniqueMap(
    snapshot.policies,
    (policy) => `${policy.namespace}/${policy.key}`,
    'policy_parent',
    'key',
    violations,
  );
  const policyVersionsByReference = uniqueMap(
    snapshot.policyVersions,
    (policy) => `${policy.namespace}/${policy.policyKey}@${policy.version}`,
    'policy_version',
    'version',
    violations,
  );
  const policies: PolicyVersion[] = [];
  for (const policy of snapshot.policies) {
    const reference = `${policy.namespace}/${policy.key}@${policy.currentVersion}`;
    if (!policyVersionsByReference.has(reference)) {
      addViolation(
        violations,
        'policy_parent',
        `${policy.namespace}/${policy.key}`,
        'current_version_not_found',
        'currentVersion',
        `Policy current version ${reference} is not present in policyVersions.`,
        policy.currentVersion,
      );
    }
  }
  for (const version of snapshot.policyVersions) {
    const parent = policiesByReference.get(`${version.namespace}/${version.policyKey}`);
    if (parent === undefined) {
      addViolation(
        violations,
        'policy_version',
        `${version.namespace}/${version.policyKey}@${version.version}`,
        'policy_parent_not_found',
        'policyKey',
        `Policy parent ${version.namespace}/${version.policyKey} does not exist.`,
        version.policyKey,
      );
      continue;
    }
    policies.push({
      namespace: version.namespace,
      key: version.policyKey,
      version: version.version,
      resourceKind: version.resourceKind,
      spec: version.spec as JsonObject,
      parentStatus: parent.status,
      revision: parent.revision,
      createdAt: version.createdAt,
    });
  }

  return {
    resources: snapshot.resources as Resource[],
    providers: snapshot.providers as Provider[],
    profiles,
    policies,
    bindings: snapshot.bindings.map(toDomainBinding),
    relationships: snapshot.relationships as ResourceRelationship[],
  };
}

function validatePortableSnapshotInvariants(
  snapshot: PortableRegistrySnapshot,
  violations: RegistryViolation[],
): void {
  const actorsById = uniqueMap(snapshot.actors, (actor) => actor.id, 'actor', 'id', violations);
  const providersById = uniqueMap(
    snapshot.providers,
    (provider) => provider.id,
    'provider',
    'id',
    violations,
  );
  const resourcesById = uniqueMap(
    snapshot.resources,
    (resource) => resource.id,
    'resource',
    'id',
    violations,
  );
  const resourcesByKey = uniqueMap(
    snapshot.resources,
    (resource) => resource.key,
    'resource',
    'key',
    violations,
  );
  const operationsById = uniqueMap(
    snapshot.operations,
    (operation) => operation.id,
    'operation',
    'id',
    violations,
  );
  const eventsById = uniqueMap(
    snapshot.events,
    (event) => event.eventId,
    'event',
    'eventId',
    violations,
  );

  if (
    snapshot.actors.length > 0 &&
    !snapshot.actors.some((actor) => actor.role === 'admin' && actor.active)
  ) {
    addViolation(
      violations,
      'actor',
      'snapshot',
      'active_admin_missing',
      'actors',
      'A non-empty registry snapshot must retain an active admin actor.',
    );
  }
  for (const actor of snapshot.actors) {
    requireReference(
      actorsById,
      actor.createdBy,
      'actor',
      actor.id,
      'createdBy',
      'actor_created_by_not_found',
      violations,
    );
    requireReference(
      actorsById,
      actor.updatedBy,
      'actor',
      actor.id,
      'updatedBy',
      'actor_updated_by_not_found',
      violations,
    );
  }

  const profileParentsByKey = uniqueMap(
    snapshot.profiles,
    (profile) => profile.key,
    'profile_parent',
    'key',
    violations,
  );
  const profileVersionsByReference = uniqueMap(
    snapshot.profileVersions,
    (profile) => `${profile.profileKey}@${profile.version}`,
    'profile_version',
    'version',
    violations,
  );
  for (const profile of snapshot.profiles) {
    if (!profileVersionsByReference.has(`${profile.key}@${profile.currentVersion}`)) {
      addViolation(
        violations,
        'profile_parent',
        profile.key,
        'current_version_not_found',
        'currentVersion',
        'The current profile version must be included in the snapshot.',
        profile.currentVersion,
      );
    }
  }
  for (const version of snapshot.profileVersions) {
    if (!profileParentsByKey.has(version.profileKey)) {
      addViolation(
        violations,
        'profile_version',
        `${version.profileKey}@${version.version}`,
        'profile_parent_not_found',
        'profileKey',
        'Every profile version must have a profile parent.',
        version.profileKey,
      );
    }
    requireReference(
      actorsById,
      version.createdBy,
      'profile_version',
      `${version.profileKey}@${version.version}`,
      'createdBy',
      'profile_version_actor_not_found',
      violations,
    );
  }

  const policyParentsByReference = uniqueMap(
    snapshot.policies,
    (policy) => `${policy.namespace}/${policy.key}`,
    'policy_parent',
    'key',
    violations,
  );
  const policyVersionsByReference = uniqueMap(
    snapshot.policyVersions,
    (policy) => `${policy.namespace}/${policy.policyKey}@${policy.version}`,
    'policy_version',
    'version',
    violations,
  );
  for (const policy of snapshot.policies) {
    if (
      !policyVersionsByReference.has(`${policy.namespace}/${policy.key}@${policy.currentVersion}`)
    ) {
      addViolation(
        violations,
        'policy_parent',
        `${policy.namespace}/${policy.key}`,
        'current_version_not_found',
        'currentVersion',
        'The current policy version must be included in the snapshot.',
        policy.currentVersion,
      );
    }
  }
  for (const version of snapshot.policyVersions) {
    requireReference(
      policyParentsByReference,
      `${version.namespace}/${version.policyKey}`,
      'policy_version',
      `${version.namespace}/${version.policyKey}@${version.version}`,
      'policyKey',
      'policy_version_parent_not_found',
      violations,
    );
    requireReference(
      actorsById,
      version.createdBy,
      'policy_version',
      `${version.namespace}/${version.policyKey}@${version.version}`,
      'createdBy',
      'policy_version_actor_not_found',
      violations,
    );
  }

  for (const binding of snapshot.bindings) {
    requireReference(
      actorsById,
      binding.boundBy,
      'binding',
      binding.resourceId,
      'boundBy',
      'binding_actor_not_found',
      violations,
    );
    requireReference(
      resourcesById,
      binding.resourceId,
      'binding',
      binding.resourceId,
      'resourceId',
      'binding_resource_not_found',
      violations,
    );
    requireReference(
      providersById,
      binding.providerId,
      'binding',
      binding.resourceId,
      'providerId',
      'binding_provider_not_found',
      violations,
    );
  }
  for (const relationship of snapshot.relationships) {
    requireReference(
      resourcesById,
      relationship.sourceResourceId,
      'relationship',
      relationship.id,
      'sourceResourceId',
      'relationship_source_not_found',
      violations,
    );
    requireReference(
      resourcesById,
      relationship.targetResourceId,
      'relationship',
      relationship.id,
      'targetResourceId',
      'relationship_target_not_found',
      violations,
    );
    requireReference(
      actorsById,
      relationship.createdBy,
      'relationship',
      relationship.id,
      'createdBy',
      'relationship_actor_not_found',
      violations,
    );
  }
  for (const history of snapshot.relationshipHistory) {
    requireReference(
      resourcesById,
      history.sourceResourceId,
      'relationship_history',
      history.id,
      'sourceResourceId',
      'relationship_history_source_not_found',
      violations,
    );
    requireReference(
      resourcesById,
      history.targetResourceId,
      'relationship_history',
      history.id,
      'targetResourceId',
      'relationship_history_target_not_found',
      violations,
    );
    requireReference(
      actorsById,
      history.createdBy,
      'relationship_history',
      history.id,
      'createdBy',
      'relationship_history_actor_not_found',
      violations,
    );
    requireReference(
      actorsById,
      history.removedBy,
      'relationship_history',
      history.id,
      'removedBy',
      'relationship_history_actor_not_found',
      violations,
    );
    requireReference(
      operationsById,
      history.operationId,
      'relationship_history',
      history.id,
      'operationId',
      'relationship_history_operation_not_found',
      violations,
    );
  }
  for (const history of snapshot.bindingHistory) {
    requireReference(
      resourcesById,
      history.resourceId,
      'binding_history',
      history.id,
      'resourceId',
      'binding_history_resource_not_found',
      violations,
    );
    requireReference(
      providersById,
      history.providerId,
      'binding_history',
      history.id,
      'providerId',
      'binding_history_provider_not_found',
      violations,
    );
    requireReference(
      actorsById,
      history.boundBy,
      'binding_history',
      history.id,
      'boundBy',
      'binding_history_actor_not_found',
      violations,
    );
    requireReference(
      actorsById,
      history.unboundBy,
      'binding_history',
      history.id,
      'unboundBy',
      'binding_history_actor_not_found',
      violations,
    );
    if (history.operationId !== undefined) {
      requireReference(
        operationsById,
        history.operationId,
        'binding_history',
        history.id,
        'operationId',
        'binding_history_operation_not_found',
        violations,
      );
    }
  }
  for (const health of snapshot.health) {
    requireReference(
      resourcesById,
      health.resourceId,
      'health',
      health.resourceId,
      'resourceId',
      'health_resource_not_found',
      violations,
    );
    requireReference(
      actorsById,
      health.observedBy,
      'health',
      health.resourceId,
      'observedBy',
      'health_actor_not_found',
      violations,
    );
  }
  for (const observation of snapshot.observations) {
    requireReference(
      resourcesById,
      observation.resourceId,
      'observation',
      observation.id,
      'resourceId',
      'observation_resource_not_found',
      violations,
    );
    requireReference(
      actorsById,
      observation.observerId,
      'observation',
      observation.id,
      'observerId',
      'observation_actor_not_found',
      violations,
    );
  }
  for (const drift of snapshot.drifts) {
    requireReference(
      resourcesById,
      drift.resourceId,
      'drift',
      drift.id,
      'resourceId',
      'drift_resource_not_found',
      violations,
    );
    requireReference(
      actorsById,
      drift.createdBy,
      'drift',
      drift.id,
      'createdBy',
      'drift_actor_not_found',
      violations,
    );
    if ((drift.status === 'resolved') !== (drift.resolvedAt !== undefined)) {
      addViolation(
        violations,
        'drift',
        drift.id,
        'resolved_timestamp_mismatch',
        'resolvedAt',
        'Resolved drifts must have resolvedAt and open drifts must not.',
        drift.resolvedAt,
      );
    }
  }
  for (const operation of snapshot.operations) {
    requireReference(
      actorsById,
      operation.actorId,
      'operation',
      operation.id,
      'actorId',
      'operation_actor_not_found',
      violations,
    );
  }
  for (const resource of snapshot.operationResources) {
    requireReference(
      operationsById,
      resource.operationId,
      'operation_resource',
      `${resource.operationId}/${resource.resourceId}`,
      'operationId',
      'operation_resource_operation_not_found',
      violations,
    );
    requireReference(
      resourcesById,
      resource.resourceId,
      'operation_resource',
      `${resource.operationId}/${resource.resourceId}`,
      'resourceId',
      'operation_resource_resource_not_found',
      violations,
    );
    const target = resourcesById.get(resource.resourceId);
    if (target !== undefined && target.key !== resource.resourceKey) {
      addViolation(
        violations,
        'operation_resource',
        `${resource.operationId}/${resource.resourceId}`,
        'resource_key_mismatch',
        'resourceKey',
        'The operation resource key must match the referenced resource.',
        resource.resourceKey,
      );
    }
  }
  for (const step of snapshot.operationSteps) {
    requireReference(
      operationsById,
      step.operationId,
      'operation_step',
      step.id,
      'operationId',
      'operation_step_operation_not_found',
      violations,
    );
    if (
      (['succeeded', 'failed', 'blocked', 'skipped'] as readonly string[]).includes(step.status) !==
      (step.completedAt !== undefined)
    ) {
      addViolation(
        violations,
        'operation_step',
        step.id,
        'completion_timestamp_mismatch',
        'completedAt',
        'Terminal operation steps must have completedAt and non-terminal steps must not.',
        step.completedAt,
      );
    }
  }
  for (const change of snapshot.operationChanges) {
    requireReference(
      operationsById,
      change.operationId,
      'operation_change',
      `${change.operationId}/${change.position}`,
      'operationId',
      'operation_change_operation_not_found',
      violations,
    );
    requireReference(
      resourcesById,
      change.resourceId,
      'operation_change',
      `${change.operationId}/${change.position}`,
      'resourceId',
      'operation_change_resource_not_found',
      violations,
    );
    if (change.providerId !== undefined)
      requireReference(
        providersById,
        change.providerId,
        'operation_change',
        `${change.operationId}/${change.position}`,
        'providerId',
        'operation_change_provider_not_found',
        violations,
      );
    if (change.targetResourceId !== undefined)
      requireReference(
        resourcesById,
        change.targetResourceId,
        'operation_change',
        `${change.operationId}/${change.position}`,
        'targetResourceId',
        'operation_change_target_not_found',
        violations,
      );
    const hasProvider =
      change.providerId !== undefined &&
      change.providerResourceType !== undefined &&
      change.providerResourceId !== undefined;
    const hasRelationshipCreate =
      change.targetResourceId !== undefined && change.relationshipType !== undefined;
    const hasRelationshipRemove = change.relationshipId !== undefined;
    const validShape =
      (change.action === 'binding.replace' &&
        hasProvider &&
        !hasRelationshipCreate &&
        !hasRelationshipRemove) ||
      (change.action === 'binding.remove' &&
        !hasProvider &&
        !hasRelationshipCreate &&
        !hasRelationshipRemove) ||
      (change.action === 'relationship.create' &&
        !hasProvider &&
        hasRelationshipCreate &&
        !hasRelationshipRemove) ||
      (change.action === 'relationship.remove' &&
        !hasProvider &&
        !hasRelationshipCreate &&
        hasRelationshipRemove);
    if (!validShape) {
      addViolation(
        violations,
        'operation_change',
        `${change.operationId}/${change.position}`,
        'operation_change_shape_invalid',
        'action',
        'Operation change fields must match the action.',
        change.action,
      );
    }
  }
  const lockGenerationsByScope = uniqueMap(
    snapshot.lockGenerations,
    (lock) => lock.scope,
    'lock_generation',
    'scope',
    violations,
  );
  for (const lock of snapshot.locks) {
    requireReference(
      operationsById,
      lock.operationId,
      'lock',
      lock.scope,
      'operationId',
      'lock_operation_not_found',
      violations,
    );
    requireReference(
      actorsById,
      lock.actorId,
      'lock',
      lock.scope,
      'actorId',
      'lock_actor_not_found',
      violations,
    );
    const generation = lockGenerationsByScope.get(lock.scope)?.generation;
    if (generation === undefined || generation < lock.fencingToken) {
      addViolation(
        violations,
        'lock',
        lock.scope,
        'fencing_generation_invalid',
        'fencingToken',
        'A lock fencing token must not exceed its retained generation.',
        lock.fencingToken,
      );
    }
  }
  for (const event of snapshot.events) {
    requireReference(
      actorsById,
      event.actorId,
      'event',
      event.eventId,
      'actorId',
      'event_actor_not_found',
      violations,
    );
    if (event.resourceKey !== undefined)
      requireReference(
        resourcesByKey,
        event.resourceKey,
        'event',
        event.eventId,
        'resourceKey',
        'event_resource_not_found',
        violations,
      );
    if (event.operationId !== undefined)
      requireReference(
        operationsById,
        event.operationId,
        'event',
        event.eventId,
        'operationId',
        'event_operation_not_found',
        violations,
      );
  }
  const outboxByEventId = uniqueMap(
    snapshot.outbox,
    (message) => message.eventId,
    'outbox',
    'eventId',
    violations,
  );
  for (const event of snapshot.events) {
    const message = outboxByEventId.get(event.eventId);
    if (message === undefined) {
      addViolation(
        violations,
        'event',
        event.eventId,
        'outbox_missing',
        'eventId',
        'Every audit event must have an outbox row.',
        event.eventId,
      );
    } else if (!jsonEqual(event.payload, message.payload)) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'payload_mismatch',
        'payload',
        'The outbox payload must equal the audit event payload.',
        message.payload,
      );
    }
  }
  for (const message of snapshot.outbox) {
    if (!eventsById.has(message.eventId)) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'event_not_found',
        'eventId',
        'Every outbox row must reference an audit event.',
        message.eventId,
      );
    }
    if ((message.status === 'published') !== (message.publishedAt !== undefined)) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'published_timestamp_mismatch',
        'publishedAt',
        'Published outbox rows must have publishedAt and other rows must not.',
        message.publishedAt,
      );
    }
    if (message.consumerAttempts > MAX_OUTBOX_CONSUMER_ATTEMPTS) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'consumer_attempt_limit_exceeded',
        'consumerAttempts',
        'Outbox consumer attempts exceed the configured delivery bound.',
        message.consumerAttempts,
      );
    }
    if (message.producerAttempts > MAX_OUTBOX_PRODUCER_ATTEMPTS) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'producer_attempt_limit_exceeded',
        'producerAttempts',
        'Outbox producer attempts exceed the configured send bound.',
        message.producerAttempts,
      );
    }
    if (message.status === 'failed' && message.lastError === undefined) {
      addViolation(
        violations,
        'outbox',
        message.id,
        'failed_error_missing',
        'lastError',
        'Failed outbox rows must preserve an observable terminal error.',
      );
    }
  }
  for (const exportRecord of snapshot.exports) {
    requireReference(
      actorsById,
      exportRecord.requestedBy,
      'export',
      exportRecord.id,
      'requestedBy',
      'export_actor_not_found',
      violations,
    );
    if (exportRecord.status === 'succeeded') {
      if (exportRecord.checksum === undefined || exportRecord.completedAt === undefined) {
        addViolation(
          violations,
          'export',
          exportRecord.id,
          'succeeded_export_incomplete',
          'status',
          'Succeeded exports must include checksum, R2 object key, and completion time.',
          exportRecord.status,
        );
      }
      if (exportRecord.expiredAt === undefined && exportRecord.r2ObjectKey === undefined) {
        addViolation(
          violations,
          'export',
          exportRecord.id,
          'succeeded_export_pointer_missing',
          'r2ObjectKey',
          'A non-expired succeeded export must retain its R2 object key.',
        );
      }
      if (exportRecord.expiredAt !== undefined && exportRecord.r2ObjectKey !== undefined) {
        addViolation(
          violations,
          'export',
          exportRecord.id,
          'expired_export_pointer_present',
          'r2ObjectKey',
          'An expired export must not retain an R2 object key.',
          exportRecord.r2ObjectKey,
        );
      }
    } else if (exportRecord.completedAt !== undefined) {
      addViolation(
        violations,
        'export',
        exportRecord.id,
        'unfinished_export_completed',
        'completedAt',
        'Only succeeded exports may have completedAt.',
        exportRecord.completedAt,
      );
    }
    if (exportRecord.status !== 'succeeded' && exportRecord.expiredAt !== undefined) {
      addViolation(
        violations,
        'export',
        exportRecord.id,
        'unfinished_export_expired',
        'expiredAt',
        'Only succeeded exports may have expiredAt.',
        exportRecord.expiredAt,
      );
    }
  }
}

function requireReference<T>(
  values: Map<string, T>,
  reference: string,
  entity: string,
  key: string,
  path: string,
  code: string,
  violations: RegistryViolation[],
): void {
  if (values.has(reference)) return;
  addViolation(
    violations,
    entity,
    key,
    code,
    path,
    `Referenced object ${reference} does not exist in the snapshot.`,
    reference,
  );
}

function capture(
  violations: RegistryViolation[],
  entity: RegistryViolation['entity'],
  key: string,
  value: unknown,
  validate: () => void,
): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof GlobalRegistryError) {
      const nested = error.details?.violations;
      if (Array.isArray(nested)) {
        for (const violation of nested) {
          if (
            typeof violation === 'object' &&
            violation !== null &&
            !Array.isArray(violation) &&
            typeof violation.code === 'string' &&
            typeof violation.path === 'string' &&
            typeof violation.message === 'string'
          ) {
            addViolation(
              violations,
              entity,
              key,
              violation.code,
              violation.path,
              violation.message,
              valueAt(value, violation.path),
            );
          }
        }
        return;
      }
      addViolation(violations, entity, key, error.code, '', error.message);
      return;
    }
    addViolation(
      violations,
      entity,
      key,
      'validation_execution_error',
      '',
      error instanceof Error ? error.message : 'Unknown validation error.',
    );
  }
}

function appendEvaluation(
  violations: RegistryViolation[],
  entity: RegistryViolation['entity'],
  key: string,
  value: unknown,
  evaluated: DomainViolation[],
): void {
  for (const violation of evaluated) {
    addViolation(
      violations,
      entity,
      key,
      violation.code,
      violation.path,
      violation.message,
      valueAt(value, violation.path),
    );
  }
}

function addViolation(
  violations: RegistryViolation[],
  entity: RegistryViolation['entity'],
  key: string,
  code: string,
  path: string,
  message: string,
  currentValue?: JsonValue,
): void {
  violations.push({
    entity,
    key,
    code,
    path,
    message,
    ...(currentValue === undefined ? {} : { currentValue }),
  });
}

function uniqueMap<T>(
  values: T[],
  keyOf: (value: T) => string,
  entity: RegistryViolation['entity'],
  path: string,
  violations: RegistryViolation[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      addViolation(
        violations,
        entity,
        key,
        `duplicate_${entity}`,
        path,
        `${entity} key ${key} appears more than once.`,
        key,
      );
    } else {
      result.set(key, value);
    }
  }
  return result;
}

function currentValueAt(value: unknown, path: string): { currentValue?: JsonValue } {
  const currentValue = valueAt(value, path);
  return currentValue === undefined ? {} : { currentValue };
}

function valueAt(value: unknown, path: string): JsonValue | undefined {
  let current = value;
  for (const segment of path.split('.').filter((part) => part.length > 0)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return toJsonValue(current);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toJsonValue);
    return items.every((item) => item !== undefined) ? (items as JsonValue[]) : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = toJsonValue(child);
      if (normalized === undefined) return undefined;
      result[key] = normalized;
    }
    return result;
  }
  return undefined;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index] as JsonValue))
    );
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonEqual(left[key] as JsonValue, (right as JsonObject)[key] as JsonValue),
      )
    );
  }
  return false;
}

function emptyCounts(): RegistryValidationReport['counts'] {
  return {
    resources: 0,
    providers: 0,
    profiles: 0,
    policies: 0,
    bindings: 0,
    relationships: 0,
  };
}

function report(
  counts: RegistryValidationReport['counts'],
  violations: RegistryViolation[],
): RegistryValidationReport {
  violations.sort(
    (left, right) =>
      left.entity.localeCompare(right.entity) ||
      left.key.localeCompare(right.key) ||
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code),
  );
  return { valid: violations.length === 0, counts, violations };
}
