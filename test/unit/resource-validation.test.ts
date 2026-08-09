import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors/global-registry-error';
import type { JsonObject, ResourceKind } from '../../src/domain/models/global-registry';
import { materializeEffectiveSpec } from '../../src/domain/resource/profile';
import { validateRelationshipKinds } from '../../src/domain/resource/relationships';
import {
  validatePlacement,
  validateResourceSpec,
  validateResourceSpecOverrides,
} from '../../src/domain/resource/validation';

const validSpecs: Record<ResourceKind, JsonObject> = {
  location: { category: 'site' },
  network: { addressFamily: 'ipv4', cidrs: ['10.0.0.0/24'] },
  compute: { substrate: 'vm', architecture: 'amd64', vcpu: 2, memoryMiB: 4096 },
  volume: { capacityGiB: 100, storageClass: 'general', accessMode: 'read_write_once' },
  service_cluster: { serviceType: 'mysql', topology: 'high_availability' },
  service_instance: {
    serviceType: 'mysql',
    version: '8.4',
    configurationClass: 'standard',
  },
  endpoint: { protocol: 'https', port: 443, exposure: 'public', dnsName: 'db.example.com' },
  backup_repository: { repositoryType: 'object_storage', retentionClass: 'daily' },
};

const completeSpecs: Record<ResourceKind, JsonObject> = {
  ...validSpecs,
  network: {
    addressFamily: 'dual_stack',
    cidrs: ['10.0.0.0/24', '2001:db8::/64'],
    vlanId: 130,
    gateway: '10.0.0.1',
    dhcp: false,
  },
  compute: {
    ...validSpecs.compute,
    imageClass: 'ubuntu-2404',
    storageClass: 'general',
  },
};

const invalidTypeSpecs: Record<ResourceKind, JsonObject> = {
  location: { category: 1 },
  network: { addressFamily: 'ipv4', cidrs: '10.0.0.0/24' },
  compute: { substrate: 'vm', architecture: 'amd64', vcpu: '2', memoryMiB: 4096 },
  volume: { capacityGiB: '100', storageClass: 'general', accessMode: 'read_write_once' },
  service_cluster: { serviceType: 1, topology: 'single' },
  service_instance: {
    serviceType: 'mysql',
    version: 8.4,
    configurationClass: 'standard',
  },
  endpoint: { protocol: 'https', port: '443', exposure: 'public' },
  backup_repository: { repositoryType: 'object_storage', retentionClass: 1 },
};

const invalidValueSpecs: Record<ResourceKind, JsonObject> = {
  location: { category: 'data_center' },
  network: { addressFamily: 'ipv5', cidrs: ['10.0.0.0/24'] },
  compute: { substrate: 'vm', architecture: 'x86', vcpu: 0, memoryMiB: 4096 },
  volume: { capacityGiB: 0, storageClass: 'general', accessMode: 'exclusive' },
  service_cluster: { serviceType: 'mysql', topology: 'random' },
  service_instance: {
    serviceType: '',
    version: '8.4',
    configurationClass: 'standard',
  },
  endpoint: { protocol: 'smtp', port: 0, exposure: 'public' },
  backup_repository: { repositoryType: 'tape', retentionClass: 'daily' },
};

describe('resource domain validation', () => {
  it.each(Object.entries(validSpecs))('accepts a minimal %s specification', (kind, spec) => {
    expect(validateResourceSpec(kind as ResourceKind, spec)).toEqual(spec);
  });

  it.each(Object.entries(validSpecs))('rejects unknown %s fields', (kind, spec) => {
    expect(() =>
      validateResourceSpec(kind as ResourceKind, { ...spec, providerSpecificId: 'forbidden' }),
    ).toThrowError(ValidationError);
  });

  it.each(Object.keys(validSpecs))('rejects missing required %s fields', (kind) => {
    expect(() => validateResourceSpec(kind as ResourceKind, {})).toThrowError(ValidationError);
  });

  it.each(Object.entries(completeSpecs))('accepts a complete %s specification', (kind, spec) => {
    expect(validateResourceSpec(kind as ResourceKind, spec)).toEqual(spec);
  });

  it.each(Object.entries(invalidTypeSpecs))('rejects %s field type mismatches', (kind, spec) => {
    expect(() => validateResourceSpec(kind as ResourceKind, spec)).toThrowError(ValidationError);
  });

  it.each(Object.entries(invalidValueSpecs))(
    'rejects out-of-range or unknown %s values',
    (kind, spec) => {
      expect(() => validateResourceSpec(kind as ResourceKind, spec)).toThrowError(ValidationError);
    },
  );

  it('rejects invalid network, compute, and endpoint values', () => {
    expect(() =>
      validateResourceSpec('network', {
        addressFamily: 'ipv4',
        cidrs: ['10.0.0.1/99'],
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateResourceSpec('compute', {
        substrate: 'vm',
        architecture: 'amd64',
        vcpu: 0,
        memoryMiB: -1,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateResourceSpec('endpoint', {
        protocol: 'smtp',
        port: 0,
        exposure: 'public',
        dnsName: '-invalid.example',
      }),
    ).toThrowError(ValidationError);
  });

  it('requires network addresses to match addressFamily', () => {
    expect(() =>
      validateResourceSpec('network', {
        addressFamily: 'ipv4',
        cidrs: ['2001:db8::/64'],
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateResourceSpec('network', {
        addressFamily: 'dual_stack',
        cidrs: ['10.0.0.0/24'],
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateResourceSpec('network', {
        addressFamily: 'ipv6',
        cidrs: ['2001:db8::/64'],
        gateway: '10.0.0.1',
      }),
    ).toThrowError(ValidationError);
  });

  it('requires a location reference for non-location resources', () => {
    expect(validatePlacement('location', {})).toEqual({});
    expect(validatePlacement('compute', { locationKey: 'site-01', zone: 'dmz' })).toEqual({
      locationKey: 'site-01',
      zone: 'dmz',
    });
    expect(() => validatePlacement('compute', {})).toThrowError(ValidationError);
    expect(() => validatePlacement('location', { locationKey: 'site-01' })).toThrowError(
      ValidationError,
    );
  });

  it('validates strict partial profile and resource overrides', () => {
    expect(validateResourceSpecOverrides('compute', { memoryMiB: 8192 })).toEqual({
      memoryMiB: 8192,
    });
    expect(() => validateResourceSpecOverrides('compute', { memoryMib: 8192 })).toThrowError(
      ValidationError,
    );
  });

  it('merges nested objects recursively and replaces arrays', () => {
    expect(
      materializeEffectiveSpec(
        { nested: { defaultValue: true, overridden: 'profile' }, labels: ['profile'] },
        { nested: { overridden: 'resource' }, labels: ['resource'] },
      ),
    ).toEqual({
      nested: { defaultValue: true, overridden: 'resource' },
      labels: ['resource'],
    });
  });

  it('accepts only the declared relationship kind matrix', () => {
    expect(() =>
      validateRelationshipKinds('service_instance', 'hosted_on', 'compute'),
    ).not.toThrow();
    expect(() => validateRelationshipKinds('compute', 'depends_on', 'compute')).not.toThrow();
    expect(() => validateRelationshipKinds('network', 'hosted_on', 'endpoint')).toThrowError(
      ValidationError,
    );
  });
});
