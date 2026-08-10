export const PROVIDER_STATUSES = ['active', 'disabled', 'retired'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export type ProviderCapability = string;

export interface ProviderCapabilities {
  resourceKinds: string[];
  features: ProviderCapability[];
  architectures: string[];
}
