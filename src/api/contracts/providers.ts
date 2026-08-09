import { createRoute, z } from '@hono/zod-openapi';
import type { Provider } from '../../domain/models/global-registry';
import { providerRecordSchema } from '../../domain/models/schemas';
import { providerDefinitionSchema, providerStatusSchema } from '../../domain/provider/schemas';
import {
  jsonRequest,
  jsonResponse,
  keySchema,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
  revisionSchema,
} from './common';
import { standardErrorResponses } from './errors';

const listProvidersQuerySchema = z
  .object({ limit: pageLimitSchema.optional() })
  .strict()
  .openapi('ListProvidersQuery');

function createProviderVariant<const Index extends 0 | 1 | 2 | 3>(index: Index) {
  const schema = providerDefinitionSchema.options[index];
  return schema.extend({ status: providerStatusSchema.default('active') }).strict();
}

function providerResponseVariant<const Index extends 0 | 1 | 2 | 3>(index: Index) {
  const schema = providerRecordSchema.options[index];
  return schema
    .extend({
      id: schema.shape.id.openapi({ readOnly: true }),
      bindingRevision: schema.shape.bindingRevision.openapi({ readOnly: true }),
      revision: schema.shape.revision.openapi({ readOnly: true }),
      createdAt: schema.shape.createdAt.openapi({ readOnly: true }),
      updatedAt: schema.shape.updatedAt.openapi({ readOnly: true }),
    })
    .strict();
}

function hasMutableProviderField(value: {
  driver?: unknown;
  credentialRef?: unknown;
  status?: unknown;
  capabilities?: unknown;
  mappings?: unknown;
}): boolean {
  return (
    value.driver !== undefined ||
    value.credentialRef !== undefined ||
    value.status !== undefined ||
    value.capabilities !== undefined ||
    value.mappings !== undefined
  );
}

const createProviderRequestSchema = z
  .discriminatedUnion('driver', [
    createProviderVariant(0),
    createProviderVariant(1),
    createProviderVariant(2),
    createProviderVariant(3),
  ])
  .openapi('CreateProviderRequest');

const updateProviderRequestSchema = z
  .union([
    providerDefinitionSchema.options[0]
      .omit({ id: true })
      .partial()
      .extend({ expectedRevision: revisionSchema })
      .strict()
      .refine(hasMutableProviderField, 'At least one mutable provider field is required.'),
    providerDefinitionSchema.options[1]
      .omit({ id: true })
      .partial()
      .extend({ expectedRevision: revisionSchema })
      .strict()
      .refine(hasMutableProviderField, 'At least one mutable provider field is required.'),
    providerDefinitionSchema.options[2]
      .omit({ id: true })
      .partial()
      .extend({ expectedRevision: revisionSchema })
      .strict()
      .refine(hasMutableProviderField, 'At least one mutable provider field is required.'),
    providerDefinitionSchema.options[3]
      .omit({ id: true })
      .partial()
      .extend({ expectedRevision: revisionSchema })
      .strict()
      .refine(hasMutableProviderField, 'At least one mutable provider field is required.'),
  ])
  .openapi('UpdateProviderRequest');

const providerResponseSchema = z
  .discriminatedUnion('driver', [
    providerResponseVariant(0),
    providerResponseVariant(1),
    providerResponseVariant(2),
    providerResponseVariant(3),
  ])
  .openapi('Provider');

const providerListResponseSchema = z
  .object({ items: z.array(providerResponseSchema) })
  .strict()
  .openapi('ProviderList');

const providerIdParamsSchema = z
  .object({
    id: keySchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'provider-primary',
    }),
  })
  .openapi('ProviderIdPathParameters');

const providerExample = {
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
  bindingRevision: 0,
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T01:00:00.000Z',
} as const;

export const createProviderRoute = createRoute({
  method: 'post',
  path: '/api/v1/providers',
  operationId: 'createProvider',
  tags: ['Providers'],
  summary: 'Create a provider',
  description:
    'Creates a provider using driver-specific capabilities and mappings. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createProviderRequestSchema,
      'The immutable provider ID, driver, credential reference, capabilities, and mappings.',
      {
        id: providerExample.id,
        driver: providerExample.driver,
        credentialRef: providerExample.credentialRef,
        status: providerExample.status,
        capabilities: providerExample.capabilities,
        mappings: providerExample.mappings,
      },
    ),
  },
  responses: {
    201: jsonResponse(providerResponseSchema, 'The newly created provider.', providerExample),
    ...standardErrorResponses(),
  },
});

export const listProvidersRoute = createRoute({
  method: 'get',
  path: '/api/v1/providers',
  operationId: 'listProviders',
  tags: ['Providers'],
  summary: 'List providers',
  description:
    'Lists all active, disabled, and retired providers. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listProvidersQuerySchema },
  responses: {
    200: jsonResponse(providerListResponseSchema, 'All registered providers.', {
      items: [providerExample],
    }),
    ...standardErrorResponses(),
  },
});

export const getProviderRoute = createRoute({
  method: 'get',
  path: '/api/v1/providers/{id}',
  operationId: 'getProvider',
  tags: ['Providers'],
  summary: 'Get a provider',
  description:
    'Returns one provider by immutable provider ID. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: providerIdParamsSchema },
  responses: {
    200: jsonResponse(providerResponseSchema, 'The requested provider.', providerExample),
    ...standardErrorResponses(),
  },
});

export const updateProviderRoute = createRoute({
  method: 'patch',
  path: '/api/v1/providers/{id}',
  operationId: 'updateProvider',
  tags: ['Providers'],
  summary: 'Update a provider',
  description:
    'Updates provider configuration with optimistic locking and revalidates every active binding and policy. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: providerIdParamsSchema,
    body: jsonRequest(
      updateProviderRequestSchema,
      'Mutable provider fields and the expected current revision.',
      { status: 'disabled', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(providerResponseSchema, 'The updated provider.', {
      ...providerExample,
      status: 'disabled',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export function toProviderResponse(provider: Provider) {
  return parseResponse(providerResponseSchema, provider);
}

export function toProviderListResponse(providers: Provider[]) {
  return parseResponse(providerListResponseSchema, {
    items: providers.map(toProviderResponse),
  });
}
