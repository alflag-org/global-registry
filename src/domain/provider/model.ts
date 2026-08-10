import type { ResourceKind } from '../models/global-registry';

export const PROVIDER_STATUSES = ['active', 'disabled', 'retired'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export type ProviderCapability = string;

export interface ProviderCapabilities {
  resourceKinds: ResourceKind[];
  features: ProviderCapability[];
  architectures: string[];
}
