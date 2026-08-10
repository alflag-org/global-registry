import type { DomainViolation } from '../errors/violations';
import type {
  Provider,
  ProviderBinding,
  Resource,
  ResourceKindDefinitionVersion,
  StandardResourceKind,
} from '../models/global-registry';
import { providerCapabilitiesSchema } from '../provider/schemas';
import { placementSchema, resourceSpecSchemas } from '../resource/schemas';
import { isStandardResourceKind } from '../resource-kind/validation';
import type { PolicyVersionDefinition } from './model';
import { commonPolicySpecSchema, policySpecSchemas } from './schemas';

interface PolicyEvaluationInput {
  resource: Resource;
  policy: PolicyVersionDefinition;
  definition: ResourceKindDefinitionVersion;
  provider?: Provider;
  binding?: ProviderBinding;
}

interface PolicyEvaluationResult {
  valid: boolean;
  violations: DomainViolation[];
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  if (
    input.policy.resourceKind !== input.resource.kind ||
    input.policy.resourceKindVersion !== input.resource.kindVersion
  ) {
    return {
      valid: false,
      violations: [
        {
          code: 'policy_resource_kind_mismatch',
          path: 'policy.resourceKind',
          message: `Policy kind ${input.policy.resourceKind}@${input.policy.resourceKindVersion} does not match resource kind ${input.resource.kind}@${input.resource.kindVersion}.`,
        },
      ],
    };
  }

  const placement = placementSchema.parse(input.resource.placement);
  const standardKind =
    input.definition.specificationMode === 'standard' && isStandardResourceKind(input.resource.kind)
      ? input.resource.kind
      : undefined;
  const spec =
    standardKind === undefined
      ? input.resource.spec
      : resourceSpecSchemas[standardKind].parse(input.resource.spec);
  const policySpec =
    standardKind === undefined
      ? commonPolicySpecSchema.parse(input.policy.spec)
      : policySpecSchemas[standardKind].parse(input.policy.spec);
  const violations: DomainViolation[] = [];

  checkAllowed(
    violations,
    policySpec.allowedZones,
    placement.zone,
    'zone_not_allowed',
    'placement.zone',
  );

  if (input.provider !== undefined && policySpec.requiredProviderCapabilities !== undefined) {
    const capabilities = providerCapabilitiesSchema.parse(input.provider.capabilities);
    for (const capability of policySpec.requiredProviderCapabilities) {
      if (!capabilities.features.includes(capability)) {
        violations.push({
          code: 'missing_policy_capability',
          path: 'provider.capabilities.features',
          message: `Provider ${input.provider.id} does not provide ${capability}.`,
        });
      }
    }
  }

  if (standardKind !== undefined) evaluateKindPolicy(standardKind, spec, policySpec, violations);
  return { valid: violations.length === 0, violations };
}

function evaluateKindPolicy(
  kind: StandardResourceKind,
  spec: Record<string, unknown>,
  policy: Record<string, unknown>,
  violations: DomainViolation[],
): void {
  switch (kind) {
    case 'location':
      checkAllowed(
        violations,
        stringArray(policy.allowedCategories),
        stringValue(spec.category),
        'category_not_allowed',
        'spec.category',
      );
      return;
    case 'network':
      checkAllowed(
        violations,
        stringArray(policy.allowedAddressFamilies),
        stringValue(spec.addressFamily),
        'address_family_not_allowed',
        'spec.addressFamily',
      );
      checkMaximum(
        violations,
        numberValue(policy.maximumCidrCount),
        Array.isArray(spec.cidrs) ? spec.cidrs.length : undefined,
        'cidr_count_above_maximum',
        'spec.cidrs',
      );
      return;
    case 'compute':
      checkAllowed(
        violations,
        stringArray(policy.allowedSubstrates),
        stringValue(spec.substrate),
        'substrate_not_allowed',
        'spec.substrate',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedArchitectures),
        stringValue(spec.architecture),
        'architecture_not_allowed',
        'spec.architecture',
      );
      checkBounds(
        violations,
        boundsValue(policy.vcpu),
        numberValue(spec.vcpu),
        'vcpu',
        'spec.vcpu',
      );
      checkBounds(
        violations,
        boundsValue(policy.memoryMiB),
        numberValue(spec.memoryMiB),
        'memory',
        'spec.memoryMiB',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedImageClasses),
        stringValue(spec.imageClass),
        'image_class_not_allowed',
        'spec.imageClass',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedStorageClasses),
        stringValue(spec.storageClass),
        'storage_class_not_allowed',
        'spec.storageClass',
      );
      return;
    case 'volume':
      checkBounds(
        violations,
        boundsValue(policy.capacityGiB),
        numberValue(spec.capacityGiB),
        'capacity',
        'spec.capacityGiB',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedStorageClasses),
        stringValue(spec.storageClass),
        'storage_class_not_allowed',
        'spec.storageClass',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedAccessModes),
        stringValue(spec.accessMode),
        'access_mode_not_allowed',
        'spec.accessMode',
      );
      return;
    case 'service_cluster':
      checkAllowed(
        violations,
        stringArray(policy.allowedServiceTypes),
        stringValue(spec.serviceType),
        'service_type_not_allowed',
        'spec.serviceType',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedTopologies),
        stringValue(spec.topology),
        'topology_not_allowed',
        'spec.topology',
      );
      return;
    case 'service_instance':
      checkAllowed(
        violations,
        stringArray(policy.allowedServiceTypes),
        stringValue(spec.serviceType),
        'service_type_not_allowed',
        'spec.serviceType',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedConfigurationClasses),
        stringValue(spec.configurationClass),
        'configuration_class_not_allowed',
        'spec.configurationClass',
      );
      return;
    case 'endpoint':
      checkAllowed(
        violations,
        stringArray(policy.allowedProtocols),
        stringValue(spec.protocol),
        'protocol_not_allowed',
        'spec.protocol',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedExposures),
        stringValue(spec.exposure),
        'exposure_not_allowed',
        'spec.exposure',
      );
      checkBounds(
        violations,
        boundsValue(policy.port),
        numberValue(spec.port),
        'port',
        'spec.port',
      );
      return;
    case 'backup_repository':
      checkAllowed(
        violations,
        stringArray(policy.allowedRepositoryTypes),
        stringValue(spec.repositoryType),
        'repository_type_not_allowed',
        'spec.repositoryType',
      );
      checkAllowed(
        violations,
        stringArray(policy.allowedRetentionClasses),
        stringValue(spec.retentionClass),
        'retention_class_not_allowed',
        'spec.retentionClass',
      );
  }
}

function checkAllowed(
  violations: DomainViolation[],
  allowed: string[] | undefined,
  actual: string | undefined,
  code: string,
  path: string,
): void {
  if (allowed === undefined || actual === undefined || allowed.includes(actual)) return;
  violations.push({ code, path, message: `${actual} is not allowed by the selected policy.` });
}

function checkBounds(
  violations: DomainViolation[],
  bounds: { minimum?: number; maximum?: number } | undefined,
  actual: number | undefined,
  codePrefix: string,
  path: string,
): void {
  if (bounds === undefined || actual === undefined) return;
  if (bounds.minimum !== undefined && actual < bounds.minimum) {
    violations.push({
      code: `${codePrefix}_below_minimum`,
      path,
      message: `${path} must be greater than or equal to ${bounds.minimum}.`,
    });
  }
  if (bounds.maximum !== undefined && actual > bounds.maximum) {
    violations.push({
      code: `${codePrefix}_above_maximum`,
      path,
      message: `${path} must be less than or equal to ${bounds.maximum}.`,
    });
  }
}

function checkMaximum(
  violations: DomainViolation[],
  maximum: number | undefined,
  actual: number | undefined,
  code: string,
  path: string,
): void {
  if (maximum === undefined || actual === undefined || actual <= maximum) return;
  violations.push({
    code,
    path,
    message: `${path} must contain no more than ${maximum} values.`,
  });
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function boundsValue(value: unknown): { minimum?: number; maximum?: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const minimum = numberValue(record.minimum);
  const maximum = numberValue(record.maximum);
  return {
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}
