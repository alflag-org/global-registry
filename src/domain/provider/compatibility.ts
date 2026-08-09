import type { DomainViolation } from '../errors/violations';
import type {
  Provider,
  Resource,
  ResourceKindDefinitionVersion,
  StandardResourceKind,
} from '../models/global-registry';
import type { ProviderCapabilities, ProviderCapability, ProviderStatus } from './model';
import { providerCapabilitiesSchema, providerDriverSchema } from './schemas';
import { placementSchema, resourceSpecSchemas } from '../resource/schemas';
import { isStandardResourceKind } from '../resource-kind/validation';

interface CompatibilityInput {
  resource: Resource;
  provider: Provider;
  definition: ResourceKindDefinitionVersion;
  requireActive?: boolean;
}

interface CompatibilityResult {
  valid: boolean;
  violations: DomainViolation[];
}

export function evaluateProviderCompatibility(input: CompatibilityInput): CompatibilityResult {
  const violations: DomainViolation[] = [];
  const provider = parseProvider(input.provider);
  const standardKind =
    input.definition.specificationMode === 'standard' && isStandardResourceKind(input.resource.kind)
      ? input.resource.kind
      : undefined;
  const resourceSpec =
    standardKind === undefined
      ? input.resource.spec
      : resourceSpecSchemas[standardKind].parse(input.resource.spec);
  const placement = placementSchema.parse(input.resource.placement);

  if ((input.requireActive ?? true) && provider.status !== 'active') {
    violations.push({
      code: 'provider_not_active',
      path: 'provider.status',
      message: `Provider ${provider.id} is not active.`,
    });
  }

  if (!provider.capabilities.resourceKinds.includes(input.resource.kind)) {
    violations.push({
      code: 'unsupported_resource_kind',
      path: 'provider.capabilities.resourceKinds',
      message: `Provider ${provider.id} does not support ${input.resource.kind}.`,
    });
  }

  for (const capability of standardKind === undefined
    ? []
    : requiredCapabilities(standardKind, resourceSpec)) {
    if (!provider.capabilities.features.includes(capability)) {
      violations.push({
        code: 'missing_resource_capability',
        path: 'provider.capabilities.features',
        message: `Provider ${provider.id} does not provide ${capability}, which is required by this resource.`,
      });
    }
  }

  const architecture =
    standardKind === undefined
      ? undefined
      : 'architecture' in resourceSpec && typeof resourceSpec.architecture === 'string'
        ? resourceSpec.architecture
        : undefined;
  if (architecture !== undefined && !provider.capabilities.architectures.includes(architecture)) {
    violations.push({
      code: 'unsupported_architecture',
      path: 'spec.architecture',
      message: `Provider ${provider.id} does not support architecture ${architecture}.`,
    });
  }

  const selector = placement.providerSelector;
  if (selector?.providerIds !== undefined && !selector.providerIds.includes(provider.id)) {
    violations.push({
      code: 'provider_id_not_selected',
      path: 'placement.providerSelector.providerIds',
      message: `Provider ${provider.id} is not selected by placement.`,
    });
  }
  if (selector?.drivers !== undefined && !selector.drivers.includes(provider.driver)) {
    violations.push({
      code: 'provider_driver_not_selected',
      path: 'placement.providerSelector.drivers',
      message: `Provider driver ${provider.driver} is not selected by placement.`,
    });
  }
  for (const capability of selector?.requiredCapabilities ?? []) {
    if (!provider.capabilities.features.includes(capability)) {
      violations.push({
        code: 'missing_required_capability',
        path: 'placement.providerSelector.requiredCapabilities',
        message: `Provider ${provider.id} does not provide ${capability}.`,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

function requiredCapabilities(
  kind: StandardResourceKind,
  spec: Record<string, unknown>,
): ProviderCapability[] {
  switch (kind) {
    case 'location':
      return ['location.manage'];
    case 'network':
      return spec.vlanId === undefined ? ['network.virtual'] : ['network.virtual', 'network.vlan'];
    case 'compute':
      switch (spec.substrate) {
        case 'vm':
          return ['compute.vm'];
        case 'container':
          return ['compute.container'];
        case 'bare_metal':
          return ['compute.bare-metal'];
        default:
          return [];
      }
    case 'volume':
      return ['volume.block'];
    case 'service_cluster':
      return ['service.cluster'];
    case 'service_instance':
      return ['service.instance'];
    case 'endpoint':
      return spec.dnsName === undefined ? [] : ['endpoint.dns'];
    case 'backup_repository':
      return spec.repositoryType === 'filesystem' ? ['backup.filesystem'] : ['backup.object'];
  }
}

function parseProvider(provider: Provider): {
  id: string;
  driver: string;
  status: ProviderStatus;
  capabilities: ProviderCapabilities;
} {
  return {
    id: provider.id,
    driver: providerDriverSchema.parse(provider.driver),
    status: provider.status,
    capabilities: providerCapabilitiesSchema.parse(provider.capabilities),
  };
}
