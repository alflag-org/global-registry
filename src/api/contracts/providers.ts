import { createRoute, z } from '@hono/zod-openapi';
import type { Provider } from '../../domain/models/global-registry';
import { providerRecordSchema } from '../../domain/models/schemas';
import {
  credentialReferenceSchema,
  providerCapabilitiesSchema,
  providerDefinitionSchema,
  providerDriverSchema,
  providerStatusSchema,
} from '../../domain/provider/schemas';
import {
  jsonRequest,
  jsonResponse,
  jsonObjectSchema,
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

const providerConfigurationSchema = jsonObjectSchema.describe(
  'Bounded non-secret configuration interpreted by the external provider adapter.',
);
const providerMappingsSchema = jsonObjectSchema.describe(
  'Bounded non-secret logical-to-provider mappings interpreted by the external adapter.',
);

function hasMutableProviderField(value: {
  driver?: unknown;
  credentialRef?: unknown;
  status?: unknown;
  capabilities?: unknown;
  configuration?: unknown;
  mappings?: unknown;
}): boolean {
  return (
    value.driver !== undefined ||
    value.credentialRef !== undefined ||
    value.status !== undefined ||
    value.capabilities !== undefined ||
    value.configuration !== undefined ||
    value.mappings !== undefined
  );
}

const createProviderRequestSchema = z
  .object({
    ...providerDefinitionSchema.shape,
    status: providerStatusSchema.default('active'),
    configuration: providerConfigurationSchema.default({}),
    mappings: providerMappingsSchema.default({}),
  })
  .strict()
  .openapi('CreateProviderRequest');

const updateProviderRequestSchema = z
  .object({
    driver: providerDriverSchema.optional(),
    credentialRef: credentialReferenceSchema.optional(),
    status: providerStatusSchema.optional(),
    capabilities: providerCapabilitiesSchema.optional(),
    configuration: providerConfigurationSchema.optional(),
    mappings: providerMappingsSchema.optional(),
    expectedRevision: revisionSchema,
  })
  .strict()
  .refine(hasMutableProviderField, 'At least one mutable provider field is required.')
  .openapi('UpdateProviderRequest');

const providerResponseSchema = z
  .object({
    ...providerRecordSchema.shape,
    id: providerRecordSchema.shape.id.openapi({ readOnly: true }),
    configuration: providerConfigurationSchema,
    mappings: providerMappingsSchema,
    bindingRevision: providerRecordSchema.shape.bindingRevision.openapi({ readOnly: true }),
    revision: providerRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: providerRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    updatedAt: providerRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
  })
  .strict()
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
  driver: 'example.internal',
  credentialRef: 'PROVIDER_CREDENTIAL',
  status: 'active',
  capabilities: {
    resourceKinds: ['compute'],
    features: ['compute.vm', 'custom.example.snapshot'],
    architectures: ['amd64'],
  },
  configuration: { region: 'primary' },
  mappings: {
    networks: { dmz: 'network-130' },
    storageClasses: { general: 'volume-standard' },
    imageClasses: { 'ubuntu-2404': 'image-2404' },
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
    'Creates a provider. Global Registry validates provider-neutral fields and preserves configuration and mappings as non-secret JSON for an external adapter. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createProviderRequestSchema,
      'The immutable provider ID, stable driver identifier, credential reference, capabilities, configuration, and mappings.',
      {
        id: providerExample.id,
        driver: providerExample.driver,
        credentialRef: providerExample.credentialRef,
        status: providerExample.status,
        capabilities: providerExample.capabilities,
        configuration: providerExample.configuration,
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
    'Updates a provider with optimistic locking and revalidates every active binding and policy against provider-neutral capabilities. Requires the admin role.',
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
