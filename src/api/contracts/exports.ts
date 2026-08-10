import { createRoute, z } from '@hono/zod-openapi';
import type { ExportRecord } from '../../domain/models/global-registry';
import { exportRecordSchema } from '../../domain/models/schemas';
import { PORTABLE_EXPORT_SCHEMA_VERSION } from '../../application/limits';
import {
  identifierSchema,
  jsonRequest,
  jsonResponse,
  parseResponse,
  protectedRouteMetadata,
} from './common';
import { standardErrorResponses } from './errors';

const createExportRequestSchema = z
  .object({
    format: z.literal('portable-json'),
  })
  .strict()
  .openapi('CreateExportRequest');

const exportRecordResponseSchema = exportRecordSchema
  .extend({
    id: exportRecordSchema.shape.id.openapi({ readOnly: true }),
    schemaVersion: exportRecordSchema.shape.schemaVersion.openapi({ readOnly: true }),
    checksum: exportRecordSchema.shape.checksum.unwrap().nullable().openapi({ readOnly: true }),
    r2ObjectKey: exportRecordSchema.shape.r2ObjectKey
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    revision: exportRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: exportRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    completedAt: exportRecordSchema.shape.completedAt
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    requestedBy: exportRecordSchema.shape.requestedBy.openapi({ readOnly: true }),
    errorMessage: exportRecordSchema.shape.errorMessage
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    expiredAt: exportRecordSchema.shape.expiredAt.unwrap().nullable().openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ExportRecord');

const exportIdParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'export-b4934e8b',
    }),
  })
  .openapi('ExportIdPathParameters');

const exportExample = {
  id: 'export-b4934e8b',
  schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
  checksum: null,
  r2ObjectKey: null,
  status: 'planned',
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  completedAt: null,
  requestedBy: 'actor-a28ca7c4',
  errorMessage: null,
  expiredAt: null,
} as const;

export const createExportRoute = createRoute({
  method: 'post',
  path: '/api/v1/exports',
  operationId: 'createExport',
  tags: ['Exports'],
  summary: 'Request a portable registry export',
  description:
    'Creates an asynchronous export request for the current chunked portable JSON format. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createExportRequestSchema,
      'The explicitly selected supported export format.',
      { format: 'portable-json' },
    ),
  },
  responses: {
    202: jsonResponse(exportRecordResponseSchema, 'The accepted export request.', exportExample),
    ...standardErrorResponses(),
  },
});

export const getExportRoute = createRoute({
  method: 'get',
  path: '/api/v1/exports/{id}',
  operationId: 'getExport',
  tags: ['Exports'],
  summary: 'Get an export request',
  description:
    'Returns export status and, after completion, the checksum of the serialized portable manifest and its R2 key. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: exportIdParamsSchema },
  responses: {
    200: jsonResponse(exportRecordResponseSchema, 'The requested export record.', exportExample),
    ...standardErrorResponses(),
  },
});

export function toExportRecordResponse(record: ExportRecord) {
  return parseResponse(exportRecordResponseSchema, {
    ...record,
    checksum: record.checksum ?? null,
    r2ObjectKey: record.r2ObjectKey ?? null,
    completedAt: record.completedAt ?? null,
    errorMessage: record.errorMessage ?? null,
    expiredAt: record.expiredAt ?? null,
  });
}
