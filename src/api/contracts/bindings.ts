import { createRoute, z } from '@hono/zod-openapi';
import type { ProviderBinding } from '../../domain/models/global-registry';
import { providerBindingRecordSchema } from '../../domain/models/schemas';
import {
  identifierSchema,
  jsonObjectSchema,
  jsonRequest,
  jsonResponse,
  keySchema,
  noContentResponse,
  parseResponse,
  protectedRouteMetadata,
  revisionSchema,
} from './common';
import { standardErrorResponses } from './errors';

export const providerBindingResponseSchema = providerBindingRecordSchema
  .extend({
    resourceId: providerBindingRecordSchema.shape.resourceId.openapi({ readOnly: true }),
    providerResourceName: providerBindingRecordSchema.shape.providerResourceName
      .unwrap()
      .nullable(),
    locator: jsonObjectSchema,
    boundAt: providerBindingRecordSchema.shape.boundAt.openapi({ readOnly: true }),
    boundBy: providerBindingRecordSchema.shape.boundBy.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ProviderBinding');

const replaceBindingRequestSchema = z
  .object({
    providerId: keySchema,
    providerResourceType: z.string().min(1).max(128),
    providerResourceId: z.string().min(1).max(256),
    providerResourceName: z.string().min(1).max(256).optional(),
    locator: jsonObjectSchema.default({}),
    expectedRevision: revisionSchema,
    operationId: identifierSchema,
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('ReplaceBindingRequest');

const removeBindingRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    operationId: identifierSchema,
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('RemoveBindingRequest');

const bindingResourceParamsSchema = z
  .object({
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'web-01',
    }),
  })
  .openapi('BindingResourcePathParameters');

const bindingExample = {
  resourceId: 'resource-6fd894bf',
  providerId: 'provider-primary',
  providerResourceType: 'qemu',
  providerResourceId: '100',
  providerResourceName: 'web-01',
  locator: { cluster: 'main' },
  boundAt: '2026-07-28T01:00:00.000Z',
  boundBy: 'actor-a28ca7c4',
} as const;

export const replaceBindingRoute = createRoute({
  method: 'put',
  path: '/api/v1/resources/{key}/binding',
  operationId: 'replaceProviderBinding',
  tags: ['Bindings'],
  summary: 'Replace a provider binding',
  description:
    'Creates or replaces a provider binding after operation-plan, fencing, provider compatibility, and policy validation. Requires provisioner or operator.',
  ...protectedRouteMetadata('provisioner', 'operator'),
  request: {
    params: bindingResourceParamsSchema,
    body: jsonRequest(
      replaceBindingRequestSchema,
      'The provider locator, expected resource revision, operation, and fencing token.',
      {
        providerId: bindingExample.providerId,
        providerResourceType: bindingExample.providerResourceType,
        providerResourceId: bindingExample.providerResourceId,
        providerResourceName: bindingExample.providerResourceName,
        locator: bindingExample.locator,
        expectedRevision: 1,
        operationId: 'operation-b75ecf35',
        fencingToken: 1,
      },
    ),
  },
  responses: {
    200: jsonResponse(
      providerBindingResponseSchema,
      'The active provider binding.',
      bindingExample,
    ),
    ...standardErrorResponses(),
  },
});

export const removeBindingRoute = createRoute({
  method: 'delete',
  path: '/api/v1/resources/{key}/binding',
  operationId: 'removeProviderBinding',
  tags: ['Bindings'],
  summary: 'Remove a provider binding',
  description:
    'Removes a binding only from a Resource in a terminal lifecycle state under the planned destructive operation and valid fencing token. Requires operator.',
  ...protectedRouteMetadata('operator'),
  request: {
    params: bindingResourceParamsSchema,
    body: jsonRequest(
      removeBindingRequestSchema,
      'The expected resource revision, destructive operation, and fencing token.',
      {
        expectedRevision: 4,
        operationId: 'operation-b75ecf35',
        fencingToken: 2,
      },
    ),
  },
  responses: {
    204: noContentResponse,
    ...standardErrorResponses(),
  },
});

export function toProviderBindingResponse(binding: ProviderBinding) {
  return parseResponse(providerBindingResponseSchema, {
    ...binding,
    providerResourceName: binding.providerResourceName ?? null,
  });
}
