import type { DomainViolation } from '../errors/violations';
import type { Provider, ProviderBinding, Resource, ResourceKind } from '../models/global-registry';
import type {
  ProviderCapabilities,
  ProviderCapability,
  ProviderDriver,
  ProviderStatus,
} from './model';
import { providerCapabilitiesSchema, providerMappingSchemas } from './schemas';
import { placementSchema, resourceSpecSchemas } from '../resource/schemas';

type ProviderResourceTypeMatrix = Record<ProviderDriver, Partial<Record<ResourceKind, string[]>>>;

const PROVIDER_RESOURCE_TYPES: ProviderResourceTypeMatrix = {
  proxmox: {
    network: ['network'],
    compute: ['qemu', 'lxc'],
    volume: ['volume'],
  },
  cloudflare: {
    network: ['dns_zone'],
    service_instance: ['worker'],
    endpoint: ['dns_record'],
    backup_repository: ['r2_bucket'],
  },
  aws: {
    network: ['vpc'],
    compute: ['ec2_instance'],
    volume: ['ebs_volume', 'efs_file_system'],
    service_cluster: ['ecs_cluster', 'eks_cluster'],
    service_instance: ['ecs_service', 'lambda_function'],
    endpoint: ['elb', 'route53_record'],
    backup_repository: ['s3_bucket'],
  },
  gcp: {
    network: ['network'],
    compute: ['compute_instance'],
    volume: ['persistent_disk'],
    service_cluster: ['gke_cluster'],
    service_instance: ['cloud_run_service', 'cloud_function'],
    endpoint: ['forwarding_rule', 'dns_record'],
    backup_repository: ['storage_bucket'],
  },
};

interface CompatibilityInput {
  resource: Resource;
  provider: Provider;
  binding: Pick<ProviderBinding, 'providerResourceType'>;
  requireActive?: boolean;
}

interface CompatibilityResult {
  valid: boolean;
  violations: DomainViolation[];
}

export function evaluateProviderCompatibility(input: CompatibilityInput): CompatibilityResult {
  const violations: DomainViolation[] = [];
  const provider = parseProvider(input.provider);
  const resourceSpec = resourceSpecSchemas[input.resource.kind].parse(input.resource.spec);
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

  for (const capability of requiredCapabilities(input.resource.kind, resourceSpec)) {
    if (!provider.capabilities.features.includes(capability)) {
      violations.push({
        code: 'missing_resource_capability',
        path: 'provider.capabilities.features',
        message: `Provider ${provider.id} does not provide ${capability}, which is required by this resource.`,
      });
    }
  }

  const architecture =
    'architecture' in resourceSpec && typeof resourceSpec.architecture === 'string'
      ? resourceSpec.architecture
      : undefined;
  if (
    architecture !== undefined &&
    !provider.capabilities.architectures.includes(architecture as 'amd64' | 'arm64')
  ) {
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
    if (!provider.capabilities.features.includes(capability as never)) {
      violations.push({
        code: 'missing_required_capability',
        path: 'placement.providerSelector.requiredCapabilities',
        message: `Provider ${provider.id} does not provide ${capability}.`,
      });
    }
  }

  if (placement.zone !== undefined && provider.mappings.networks[placement.zone] === undefined) {
    violations.push({
      code: 'missing_network_mapping',
      path: 'placement.zone',
      message: `Provider ${provider.id} does not define network mapping ${placement.zone}.`,
    });
  }

  const imageClass =
    'imageClass' in resourceSpec && typeof resourceSpec.imageClass === 'string'
      ? resourceSpec.imageClass
      : undefined;
  if (imageClass !== undefined && provider.mappings.imageClasses[imageClass] === undefined) {
    violations.push({
      code: 'missing_image_mapping',
      path: 'spec.imageClass',
      message: `Provider ${provider.id} does not define image mapping ${imageClass}.`,
    });
  }

  const storageClass =
    'storageClass' in resourceSpec && typeof resourceSpec.storageClass === 'string'
      ? resourceSpec.storageClass
      : undefined;
  if (storageClass !== undefined && provider.mappings.storageClasses[storageClass] === undefined) {
    violations.push({
      code: 'missing_storage_mapping',
      path: 'spec.storageClass',
      message: `Provider ${provider.id} does not define storage mapping ${storageClass}.`,
    });
  }

  const allowedTypes = PROVIDER_RESOURCE_TYPES[provider.driver][input.resource.kind] ?? [];
  if (!allowedTypes.includes(input.binding.providerResourceType)) {
    violations.push({
      code: 'unsupported_provider_resource_type',
      path: 'providerResourceType',
      message: `${input.binding.providerResourceType} is not valid for ${provider.driver} ${input.resource.kind}.`,
    });
  }

  return { valid: violations.length === 0, violations };
}

function requiredCapabilities(
  kind: ResourceKind,
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
  driver: ProviderDriver;
  status: ProviderStatus;
  capabilities: ProviderCapabilities;
  mappings: {
    networks: Record<string, unknown>;
    storageClasses: Record<string, unknown>;
    imageClasses: Record<string, unknown>;
  };
} {
  const driver = provider.driver as ProviderDriver;
  const capabilities = providerCapabilitiesSchema.parse(provider.capabilities);
  const mappings = providerMappingSchemas[driver].parse(provider.mappings);
  return {
    id: provider.id,
    driver,
    status: provider.status,
    capabilities,
    mappings,
  };
}
