import { z } from 'zod';
import { RESOURCE_KINDS } from '../models/global-registry';
import { PROVIDER_CAPABILITIES, PROVIDER_DRIVERS } from '../provider/model';
import { hasUniqueValues } from '../unique-values';
import {
  ADDRESS_FAMILIES,
  ARCHITECTURES,
  BACKUP_REPOSITORY_TYPES,
  COMPUTE_SUBSTRATES,
  ENDPOINT_EXPOSURES,
  ENDPOINT_PROTOCOLS,
  LOCATION_CATEGORIES,
  SERVICE_TOPOLOGIES,
  VOLUME_ACCESS_MODES,
} from './model';

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');

const classKeySchema = stableKeySchema;
const nonEmptyStringSchema = z.string().trim().min(1).max(256);

function isIpv4(value: string): boolean {
  const segments = value.split('.');
  return (
    segments.length === 4 &&
    segments.every(
      (segment) =>
        /^\d{1,3}$/.test(segment) &&
        Number(segment) >= 0 &&
        Number(segment) <= 255 &&
        (segment === '0' || !segment.startsWith('0')),
    )
  );
}

function isIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value) || value.includes(':::')) return false;
  const compression = value.indexOf('::');
  if (compression !== -1 && compression !== value.lastIndexOf('::')) return false;
  const groups = value.split(':').filter((group) => group.length > 0);
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return compression === -1 ? groups.length === 8 : groups.length < 8;
}

function isIpAddress(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

function isCidr(value: string): boolean {
  const separator = value.lastIndexOf('/');
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  if (!Number.isInteger(prefix)) return false;
  if (isIpv4(address)) return prefix >= 0 && prefix <= 32;
  if (isIpv6(address)) return prefix >= 0 && prefix <= 128;
  return false;
}

const cidrSchema = z.string().refine(isCidr, 'CIDR must contain a valid IP address and prefix.');
const ipAddressSchema = z.string().refine(isIpAddress, 'Must be a valid IPv4 or IPv6 address.');
const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => {
    if (value.endsWith('.')) return false;
    return value
      .split('.')
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      );
  }, 'Must be a valid hostname.');

const locationSpecSchema = z
  .object({
    category: z.enum(LOCATION_CATEGORIES),
  })
  .strict();

const networkSpecBaseSchema = z
  .object({
    addressFamily: z.enum(ADDRESS_FAMILIES),
    cidrs: z.array(cidrSchema).min(1).refine(hasUniqueValues, 'CIDRs must be unique.'),
    vlanId: z.number().int().min(1).max(4094).optional(),
    gateway: ipAddressSchema.optional(),
    dhcp: z.boolean().optional(),
  })
  .strict();

const networkSpecSchema = networkSpecBaseSchema.superRefine((value, context) => {
  const cidrFamilies = new Set(
    value.cidrs.map((cidr) => (isIpv4(cidr.slice(0, cidr.lastIndexOf('/'))) ? 'ipv4' : 'ipv6')),
  );
  if (
    value.addressFamily !== 'dual_stack' &&
    cidrFamilies.has(oppositeFamily(value.addressFamily))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cidrs'],
      message: `CIDRs must match addressFamily ${value.addressFamily}.`,
    });
  }
  if (
    value.addressFamily === 'dual_stack' &&
    (!cidrFamilies.has('ipv4') || !cidrFamilies.has('ipv6'))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cidrs'],
      message: 'dual_stack networks require at least one IPv4 and one IPv6 CIDR.',
    });
  }
  if (
    value.gateway !== undefined &&
    value.addressFamily !== 'dual_stack' &&
    (isIpv4(value.gateway) ? 'ipv4' : 'ipv6') !== value.addressFamily
  ) {
    context.addIssue({
      code: 'custom',
      path: ['gateway'],
      message: `gateway must match addressFamily ${value.addressFamily}.`,
    });
  }
});

function oppositeFamily(family: 'ipv4' | 'ipv6'): 'ipv4' | 'ipv6' {
  return family === 'ipv4' ? 'ipv6' : 'ipv4';
}

const computeSpecSchema = z
  .object({
    substrate: z.enum(COMPUTE_SUBSTRATES),
    architecture: z.enum(ARCHITECTURES),
    vcpu: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    imageClass: classKeySchema.optional(),
    storageClass: classKeySchema.optional(),
  })
  .strict();

const volumeSpecSchema = z
  .object({
    capacityGiB: z.number().int().positive(),
    storageClass: classKeySchema,
    accessMode: z.enum(VOLUME_ACCESS_MODES),
  })
  .strict();

const serviceClusterSpecSchema = z
  .object({
    serviceType: classKeySchema,
    topology: z.enum(SERVICE_TOPOLOGIES),
  })
  .strict();

const serviceInstanceSpecSchema = z
  .object({
    serviceType: classKeySchema,
    version: nonEmptyStringSchema,
    configurationClass: classKeySchema,
  })
  .strict();

const endpointSpecSchema = z
  .object({
    protocol: z.enum(ENDPOINT_PROTOCOLS),
    port: z.number().int().min(1).max(65_535),
    exposure: z.enum(ENDPOINT_EXPOSURES),
    dnsName: hostnameSchema.optional(),
  })
  .strict();

const backupRepositorySpecSchema = z
  .object({
    repositoryType: z.enum(BACKUP_REPOSITORY_TYPES),
    retentionClass: classKeySchema,
  })
  .strict();

export const resourceSpecSchemas = {
  location: locationSpecSchema,
  network: networkSpecSchema,
  compute: computeSpecSchema,
  volume: volumeSpecSchema,
  service_cluster: serviceClusterSpecSchema,
  service_instance: serviceInstanceSpecSchema,
  endpoint: endpointSpecSchema,
  backup_repository: backupRepositorySpecSchema,
} as const;

export const resourceSpecOverrideSchemas = {
  location: locationSpecSchema.partial(),
  network: networkSpecBaseSchema.partial(),
  compute: computeSpecSchema.partial(),
  volume: volumeSpecSchema.partial(),
  service_cluster: serviceClusterSpecSchema.partial(),
  service_instance: serviceInstanceSpecSchema.partial(),
  endpoint: endpointSpecSchema.partial(),
  backup_repository: backupRepositorySpecSchema.partial(),
} as const;

const providerSelectorSchema = z
  .object({
    drivers: z
      .array(z.enum(PROVIDER_DRIVERS))
      .min(1)
      .refine(hasUniqueValues, 'Drivers must be unique.')
      .optional(),
    providerIds: z
      .array(stableKeySchema)
      .min(1)
      .refine(hasUniqueValues, 'Provider IDs must be unique.')
      .optional(),
    requiredCapabilities: z
      .array(z.enum(PROVIDER_CAPABILITIES))
      .min(1)
      .refine(hasUniqueValues, 'Capabilities must be unique.')
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.drivers !== undefined ||
      value.providerIds !== undefined ||
      value.requiredCapabilities !== undefined,
    'At least one provider selector restriction is required.',
  );

export const placementSchema = z
  .object({
    locationKey: stableKeySchema.optional(),
    zone: classKeySchema.optional(),
    providerSelector: providerSelectorSchema.optional(),
  })
  .strict();

export const resourceKindSchema = z.enum(RESOURCE_KINDS);
