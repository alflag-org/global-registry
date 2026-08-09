import { describe, expect, it } from 'vitest';
import { PORTABLE_EXPORT_SCHEMA_VERSION } from '../../src/application/limits';
import type {
  JsonObject,
  PolicyVersion,
  Provider,
  ProviderBinding,
  Resource,
} from '../../src/domain/models/global-registry';
import {
  type RegistrySnapshot,
  validateRegistrySnapshot,
} from '../../src/application/registry-validation';

const timestamp = '2026-07-25T00:00:00.000Z';

function snapshot(): RegistrySnapshot {
  const location: Resource = {
    id: 'resource-location',
    key: 'site-01',
    kind: 'location',
    name: 'KANAGAWA01',
    placement: {},
    specOverrides: { category: 'site' },
    spec: { category: 'site' },
    lifecycleState: 'ready',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const compute: Resource = {
    id: 'resource-compute',
    key: 'compute-1',
    kind: 'compute',
    name: 'Compute 1',
    placement: { locationKey: 'site-01', zone: 'dmz' },
    specOverrides: {
      substrate: 'vm',
      architecture: 'amd64',
      vcpu: 2,
      memoryMiB: 4096,
      imageClass: 'ubuntu-2404',
      storageClass: 'general',
    },
    spec: {
      substrate: 'vm',
      architecture: 'amd64',
      vcpu: 2,
      memoryMiB: 4096,
      imageClass: 'ubuntu-2404',
      storageClass: 'general',
    },
    policy: { namespace: 'compute', key: 'standard-vm', version: 1 },
    lifecycleState: 'ready',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const provider: Provider = {
    id: 'provider-primary',
    driver: 'proxmox',
    credentialRef: 'PROVIDER_CREDENTIAL',
    status: 'active',
    capabilities: {
      resourceKinds: ['compute'],
      features: ['compute.vm'],
      architectures: ['amd64'],
    },
    mappings: {
      networks: { dmz: { bridge: 'vmbr0', vlanTag: 130 } },
      storageClasses: { general: { storage: 'local-lvm' } },
      imageClasses: { 'ubuntu-2404': { templateId: '9000' } },
    },
    bindingRevision: 1,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const policy: PolicyVersion = {
    namespace: 'compute',
    key: 'standard-vm',
    version: 1,
    resourceKind: 'compute',
    spec: {
      allowedArchitectures: ['amd64'],
      memoryMiB: { minimum: 512, maximum: 8192 },
      requiredProviderCapabilities: ['compute.vm'],
    },
    parentStatus: 'active',
    revision: 1,
    createdAt: timestamp,
  };
  const binding: ProviderBinding = {
    resourceId: compute.id,
    providerId: provider.id,
    providerResourceType: 'qemu',
    providerResourceId: '100',
    locator: {},
    boundAt: timestamp,
    boundBy: 'actor-1',
  };
  return {
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    exportedAt: timestamp,
    actors: [
      {
        id: 'actor-1',
        identity: 'access:actor-1',
        displayName: 'Actor 1',
        role: 'admin',
        active: true,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: 'actor-1',
        updatedBy: 'actor-1',
      },
    ],
    providers: [provider] as unknown as RegistrySnapshot['providers'],
    profiles: [],
    profileVersions: [],
    policies: [
      {
        namespace: 'compute',
        key: 'standard-vm',
        status: 'active',
        currentVersion: 1,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    policyVersions: [
      {
        namespace: policy.namespace,
        policyKey: policy.key,
        version: policy.version,
        resourceKind: policy.resourceKind,
        spec: policy.spec,
        createdAt: policy.createdAt,
        createdBy: 'actor-1',
      },
    ],
    resources: [location, compute] as unknown as RegistrySnapshot['resources'],
    relationships: [],
    relationshipHistory: [],
    bindings: [{ ...binding, active: true }] as unknown as RegistrySnapshot['bindings'],
    bindingHistory: [],
    health: [],
    observations: [],
    drifts: [],
    operations: [],
    operationResources: [],
    operationSteps: [],
    operationChanges: [],
    locks: [],
    lockGenerations: [],
    events: [],
    outbox: [],
    exports: [],
  };
}

function copy(value: RegistrySnapshot): RegistrySnapshot {
  return JSON.parse(JSON.stringify(value)) as RegistrySnapshot;
}

describe('registry snapshot validation', () => {
  it('accepts a complete state that satisfies the shared domain contracts', () => {
    expect(validateRegistrySnapshot(snapshot())).toMatchObject({
      valid: true,
      counts: { resources: 2, providers: 1, policies: 1, bindings: 1 },
      violations: [],
    });
  });

  it('accepts an expired succeeded export after its R2 pointer is removed', () => {
    const value = copy(snapshot());
    value.exports = [
      {
        id: 'export-expired',
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        checksum: `sha256:${'a'.repeat(64)}`,
        status: 'succeeded',
        attempts: 1,
        revision: 2,
        createdAt: timestamp,
        completedAt: timestamp,
        requestedBy: 'actor-1',
        expiredAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    expect(validateRegistrySnapshot(value)).toMatchObject({ valid: true, violations: [] });
  });

  it.each([
    {
      code: 'invalid_value',
      mutate(value: RegistrySnapshot) {
        const resource = value.resources[1] as unknown as Resource;
        resource.spec = { ...resource.spec, vmid: 100 };
        resource.specOverrides = resource.spec;
      },
    },
    {
      code: 'missing_resource_capability',
      mutate(value: RegistrySnapshot) {
        const provider = value.providers[0] as unknown as Provider;
        provider.capabilities = {
          ...provider.capabilities,
          features: [],
        } as JsonObject;
      },
    },
    {
      code: 'memory_above_maximum',
      mutate(value: RegistrySnapshot) {
        const policyVersion = value.policyVersions[0] as unknown as PolicyVersion;
        policyVersion.spec = {
          allowedArchitectures: ['amd64'],
          memoryMiB: { maximum: 2048 },
        };
      },
    },
    {
      code: 'effective_spec_mismatch',
      mutate(value: RegistrySnapshot) {
        const resource = value.resources[1] as unknown as Resource;
        resource.spec = { ...resource.spec, memoryMiB: 1024 };
      },
    },
    {
      code: 'invalid_relationship_kinds',
      mutate(value: RegistrySnapshot) {
        value.relationships.push({
          id: 'relationship-1',
          sourceResourceId: 'resource-location',
          targetResourceId: 'resource-compute',
          relationshipType: 'uses_volume',
          revision: 1,
          createdAt: timestamp,
          createdBy: 'actor-1',
        });
      },
    },
    {
      code: 'provider_has_active_bindings',
      mutate(value: RegistrySnapshot) {
        const provider = value.providers[0] as unknown as Provider;
        provider.status = 'retired';
      },
    },
  ])('rejects import and migration state with $code', ({ code, mutate }) => {
    const value = copy(snapshot());
    mutate(value);
    const result = validateRegistrySnapshot(value);
    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(code);
  });

  it('rejects unknown fields at the import boundary', () => {
    const value = { ...snapshot(), arbitrary: true };
    const result = validateRegistrySnapshot(value);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      entity: 'snapshot',
      code: 'unknown_field',
    });
  });
});
