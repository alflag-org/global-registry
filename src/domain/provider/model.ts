import type { ResourceKind } from '../models/global-registry';

export const PROVIDER_DRIVERS = ['proxmox', 'cloudflare', 'aws', 'gcp'] as const;
export type ProviderDriver = (typeof PROVIDER_DRIVERS)[number];

export const PROVIDER_STATUSES = ['active', 'disabled', 'retired'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_CAPABILITIES = [
  'location.manage',
  'network.virtual',
  'network.vlan',
  'network.dns',
  'compute.vm',
  'compute.container',
  'compute.bare-metal',
  'volume.block',
  'service.cluster',
  'service.instance',
  'endpoint.dns',
  'backup.object',
  'backup.filesystem',
  'snapshot',
  'cloud-init',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderCapabilities {
  resourceKinds: ResourceKind[];
  features: ProviderCapability[];
  architectures: Array<'amd64' | 'arm64'>;
}
