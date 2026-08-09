import { describe, expect, it } from 'vitest';
import { ProviderService } from '../../src/application/providers';
import { ValidationError } from '../../src/domain/errors/global-registry-error';
import type {
  JsonObject,
  PolicyVersion,
  Provider,
  ProviderBinding,
  Resource,
} from '../../src/domain/models/global-registry';
import { evaluatePolicy } from '../../src/domain/policy/evaluator';
import { validatePolicyDefinition } from '../../src/domain/policy/validation';
import { evaluateProviderCompatibility } from '../../src/domain/provider/compatibility';
import { validateProviderDefinition } from '../../src/domain/provider/validation';

const capabilities = {
  resourceKinds: ['compute'],
  features: ['compute.vm', 'compute.cloud-init'],
  architectures: ['amd64'],
} satisfies JsonObject;

const mappings = {
  networks: { dmz: 'network-130' },
  storageClasses: { general: 'volume-standard' },
  imageClasses: { 'ubuntu-2404': 'image-2404' },
} satisfies JsonObject;

function computeResource(): Resource {
  return {
    id: 'resource-1',
    key: 'compute-1',
    kind: 'compute',
    name: 'Compute 1',
    placement: {
      locationKey: 'site-01',
      zone: 'dmz',
      providerSelector: {
        drivers: ['example.internal'],
        providerIds: ['provider-primary'],
        requiredCapabilities: ['compute.vm'],
      },
    },
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
    lifecycleState: 'ready',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function internalProvider(): Provider {
  return {
    id: 'provider-primary',
    driver: 'example.internal',
    credentialRef: 'PROVIDER_CREDENTIAL',
    status: 'active',
    capabilities,
    configuration: { region: 'primary' },
    mappings,
    bindingRevision: 0,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function binding(): ProviderBinding {
  return {
    resourceId: 'resource-1',
    providerId: 'provider-primary',
    providerResourceType: 'qemu',
    providerResourceId: '100',
    locator: {},
    boundAt: '2026-01-01T00:00:00.000Z',
    boundBy: 'actor-1',
  };
}

describe('provider domain validation', () => {
  it('accepts extensible drivers, capabilities, configuration, and mappings', () => {
    expect(
      validateProviderDefinition({
        id: 'internal-provider',
        driver: 'example.internal',
        credentialRef: 'INTERNAL_CREDENTIAL',
        status: 'active',
        capabilities: {
          ...capabilities,
          features: ['compute.vm', 'custom.example.foo'],
          architectures: ['amd64', 'riscv64'],
        },
        configuration: { region: 'primary', adapterOption: true },
        mappings: { arbitraryAdapterMapping: { logical: 'provider-side-id' } },
      }),
    ).toMatchObject({
      driver: 'example.internal',
      configuration: { region: 'primary', adapterOption: true },
      mappings: { arbitraryAdapterMapping: { logical: 'provider-side-id' } },
    });
  });

  it('rejects malformed identifiers and secret-like opaque configuration', () => {
    expect(() =>
      validateProviderDefinition({
        id: 'provider-primary',
        driver: 'Invalid Driver',
        credentialRef: 'PROVIDER_CREDENTIAL',
        status: 'active',
        capabilities,
        configuration: {},
        mappings,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateProviderDefinition({
        id: 'provider-primary',
        driver: 'proxmox',
        credentialRef: 'PROVIDER_CREDENTIAL',
        status: 'active',
        capabilities,
        configuration: { apiToken: 'must-not-be-stored' },
        mappings,
      }),
    ).toThrowError(ValidationError);
  });

  it('treats mappings as adapter-owned data', () => {
    expect(
      evaluateProviderCompatibility({
        resource: computeResource(),
        provider: internalProvider(),
      }),
    ).toEqual({ valid: true, violations: [] });

    const provider = internalProvider();
    provider.mappings = { adapterSpecific: { anything: true } };
    expect(
      evaluateProviderCompatibility({
        resource: computeResource(),
        provider,
      }),
    ).toEqual({ valid: true, violations: [] });
  });

  it('derives required capabilities from the resource specification', () => {
    const provider = internalProvider();
    provider.capabilities = {
      resourceKinds: ['compute'],
      features: ['compute.cloud-init'],
      architectures: ['amd64'],
    };
    const result = evaluateProviderCompatibility({
      resource: computeResource(),
      provider,
    });
    expect(result.violations).toContainEqual({
      code: 'missing_resource_capability',
      path: 'provider.capabilities.features',
      message:
        'Provider provider-primary does not provide compute.vm, which is required by this resource.',
    });
  });

  it('validates every binding page instead of stopping after the first 50 rows', async () => {
    const current = internalProvider();
    const bindings = Array.from({ length: 51 }, (_, index) => {
      const resource = computeResource();
      resource.id = `resource-${index + 1}`;
      resource.key = `compute-${index + 1}`;
      const providerBinding = binding();
      providerBinding.resourceId = resource.id;
      if (index === 50) resource.spec = { ...resource.spec, architecture: 'arm64' };
      return { binding: providerBinding, resource };
    });
    const requestedPages: Array<string | undefined> = [];
    const store = {
      getProvider: async () => current,
      createProvider: async () => current,
      listBindingsForProvider: async (_providerId: string, cursor?: string, limit?: number) => {
        requestedPages.push(cursor);
        const start = cursor === undefined ? 0 : Number(cursor);
        const page = bindings.slice(start, start + (limit ?? 50));
        return {
          items: page,
          ...(start + page.length < bindings.length
            ? { nextCursor: String(start + page.length) }
            : {}),
        };
      },
      getPolicyVersion: async () => null,
      updateProvider: async () => current,
    };
    const service = new ProviderService(store);

    await expect(
      service.update({
        actorId: 'actor-1',
        id: current.id,
        expectedRevision: current.revision,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'provider_incompatible', status: 422 });
    expect(requestedPages).toEqual([undefined, '50']);
  });

  it('passes the full binding count and membership snapshot to the CAS update', async () => {
    const current = internalProvider();
    const bindings = Array.from({ length: 51 }, (_, index) => {
      const resource = computeResource();
      resource.id = `resource-${index + 1}`;
      resource.key = `compute-${index + 1}`;
      const providerBinding = binding();
      providerBinding.resourceId = resource.id;
      return { binding: providerBinding, resource };
    });
    let updateInput:
      | { expectedBoundResourceCount: number; expectedBoundResources: Array<{ id: string }> }
      | undefined;
    const service = new ProviderService({
      getProvider: async () => current,
      createProvider: async () => current,
      listBindingsForProvider: async (_providerId, cursor, limit) => {
        const start = cursor === undefined ? 0 : Number(cursor);
        const page = bindings.slice(start, start + (limit ?? 50));
        return {
          items: page,
          ...(start + page.length < bindings.length
            ? { nextCursor: String(start + page.length) }
            : {}),
        };
      },
      getPolicyVersion: async () => null,
      updateProvider: async (input) => {
        updateInput = input;
        return current;
      },
    });

    await service.update({
      actorId: 'actor-1',
      id: current.id,
      expectedRevision: current.revision,
      status: 'disabled',
    });

    expect(updateInput?.expectedBoundResourceCount).toBe(51);
    expect(updateInput?.expectedBoundResources).toHaveLength(51);
  });
});

describe('deterministic policy evaluation', () => {
  const policy: PolicyVersion = {
    namespace: 'compute',
    key: 'standard-vm',
    version: 1,
    resourceKind: 'compute',
    spec: {
      allowedArchitectures: ['amd64'],
      vcpu: { minimum: 1, maximum: 16 },
      memoryMiB: { minimum: 512, maximum: 65536 },
      allowedZones: ['mgmt', 'dmz'],
      requiredProviderCapabilities: ['compute.vm'],
    },
    parentStatus: 'active',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('rejects invalid policy schema and resource kind mismatch', () => {
    expect(() =>
      validatePolicyDefinition({
        namespace: 'compute',
        key: 'invalid',
        resourceKind: 'compute',
        spec: { expression: 'resource.vcpu < 8' },
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validatePolicyDefinition({
        namespace: 'compute',
        key: 'zero-bounds',
        resourceKind: 'compute',
        spec: { vcpu: { maximum: 0 } },
      }),
    ).toThrowError(ValidationError);

    expect(
      evaluatePolicy({
        resource: { ...computeResource(), kind: 'endpoint' },
        policy,
      }).violations[0]?.code,
    ).toBe('policy_resource_kind_mismatch');
  });

  it('returns stable paths and codes for constraint violations', () => {
    const resource = computeResource();
    resource.spec = { ...resource.spec, memoryMiB: 131072 };
    const result = evaluatePolicy({
      resource,
      policy,
      provider: internalProvider(),
      binding: binding(),
    });
    expect(result).toEqual({
      valid: false,
      violations: [
        {
          code: 'memory_above_maximum',
          path: 'spec.memoryMiB',
          message: 'spec.memoryMiB must be less than or equal to 65536.',
        },
      ],
    });
  });

  it('enforces provider capabilities when a binding is evaluated', () => {
    const result = evaluatePolicy({
      resource: computeResource(),
      policy: {
        ...policy,
        spec: { requiredProviderCapabilities: ['storage.snapshot'] },
      },
      provider: internalProvider(),
      binding: binding(),
    });
    expect(result).toEqual({
      valid: false,
      violations: [
        {
          code: 'missing_policy_capability',
          path: 'provider.capabilities.features',
          message: 'Provider provider-primary does not provide storage.snapshot.',
        },
      ],
    });
  });
});
