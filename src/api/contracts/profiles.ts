import { createRoute, z } from '@hono/zod-openapi';
import type { ProfileVersion } from '../../domain/models/global-registry';
import { profileVersionRecordSchema } from '../../domain/models/schemas';
import type { ProfileSummary } from '../../application/profiles';
import {
  jsonRequest,
  jsonObjectSchema,
  jsonResponse,
  keySchema,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
  resourceKindSchema,
  revisionSchema,
  versionParentStatusSchema,
} from './common';
import { standardErrorResponses } from './errors';

const listProfilesQuerySchema = z
  .object({ limit: pageLimitSchema.optional() })
  .strict()
  .openapi('ListProfilesQuery');

const createProfileVersionRequestSchema = z
  .object({
    key: keySchema,
    resourceKind: resourceKindSchema,
    resourceKindVersion: revisionSchema,
    spec: jsonObjectSchema,
    expectedRevision: revisionSchema.optional(),
  })
  .strict()
  .openapi('CreateProfileVersionRequest');

const updateProfileStatusRequestSchema = z
  .object({
    status: versionParentStatusSchema,
    expectedRevision: revisionSchema,
  })
  .strict()
  .openapi('UpdateProfileStatusRequest');

const profileSpecResponseSchema = jsonObjectSchema;

const profileVersionResponseSchema = profileVersionRecordSchema
  .extend({
    key: profileVersionRecordSchema.shape.key.openapi({ readOnly: true }),
    version: profileVersionRecordSchema.shape.version.openapi({ readOnly: true }),
    resourceKind: profileVersionRecordSchema.shape.resourceKind.openapi({ readOnly: true }),
    resourceKindVersion: profileVersionRecordSchema.shape.resourceKindVersion.openapi({
      readOnly: true,
    }),
    spec: profileSpecResponseSchema,
    parentStatus: profileVersionRecordSchema.shape.parentStatus.openapi({ readOnly: true }),
    revision: profileVersionRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: profileVersionRecordSchema.shape.createdAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ProfileVersion');

const profileSummaryResponseSchema = profileVersionRecordSchema
  .pick({
    key: true,
    resourceKind: true,
    resourceKindVersion: true,
    version: true,
  })
  .extend({
    key: profileVersionRecordSchema.shape.key.openapi({ readOnly: true }),
    resourceKind: profileVersionRecordSchema.shape.resourceKind.openapi({ readOnly: true }),
    resourceKindVersion: profileVersionRecordSchema.shape.resourceKindVersion.openapi({
      readOnly: true,
    }),
    version: profileVersionRecordSchema.shape.version.openapi({ readOnly: true }),
    status: versionParentStatusSchema,
  })
  .extend({
    revision: profileVersionRecordSchema.shape.revision.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ProfileSummary');

const profileListResponseSchema = z
  .object({ items: z.array(profileSummaryResponseSchema) })
  .strict()
  .openapi('ProfileList');

const profileKeyParamsSchema = z
  .object({
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'compute-defaults',
    }),
  })
  .openapi('ProfileKeyPathParameters');

const profileVersionParamsSchema = z
  .object({
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'compute-defaults',
    }),
    version: z.coerce
      .number()
      .int()
      .positive()
      .openapi({
        param: { name: 'version', in: 'path', required: true },
        example: 1,
      }),
  })
  .openapi('ProfileVersionPathParameters');

const profileVersionExample = {
  key: 'compute-defaults',
  version: 1,
  resourceKind: 'compute',
  resourceKindVersion: 1,
  spec: { substrate: 'vm', architecture: 'amd64', vcpu: 2, memoryMiB: 4096 },
  parentStatus: 'active',
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
} as const;

const profileSummaryExample = {
  key: profileVersionExample.key,
  resourceKind: profileVersionExample.resourceKind,
  resourceKindVersion: profileVersionExample.resourceKindVersion,
  version: 1,
  status: 'active',
  revision: 1,
} as const;

export const createProfileVersionRoute = createRoute({
  method: 'post',
  path: '/api/v1/profiles',
  operationId: 'createProfileVersion',
  tags: ['Profiles'],
  summary: 'Create a profile version',
  description:
    'Creates a profile or appends an immutable version using optimistic locking. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createProfileVersionRequestSchema,
      'The profile key, resource kind, strict specification defaults, and optional expected revision.',
      {
        key: profileVersionExample.key,
        resourceKind: profileVersionExample.resourceKind,
        resourceKindVersion: profileVersionExample.resourceKindVersion,
        spec: profileVersionExample.spec,
      },
    ),
  },
  responses: {
    201: jsonResponse(
      profileVersionResponseSchema,
      'The newly created immutable profile version.',
      profileVersionExample,
    ),
    ...standardErrorResponses(),
  },
});

export const listProfilesRoute = createRoute({
  method: 'get',
  path: '/api/v1/profiles',
  operationId: 'listProfiles',
  tags: ['Profiles'],
  summary: 'List profiles',
  description:
    'Lists current profile versions and lifecycle status. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listProfilesQuerySchema },
  responses: {
    200: jsonResponse(profileListResponseSchema, 'All profile summaries.', {
      items: [profileSummaryExample],
    }),
    ...standardErrorResponses(),
  },
});

export const updateProfileStatusRoute = createRoute({
  method: 'patch',
  path: '/api/v1/profiles/{key}',
  operationId: 'updateProfileStatus',
  tags: ['Profiles'],
  summary: 'Update profile status',
  description:
    'Changes profile lifecycle status with optimistic locking. Retired profiles cannot be reactivated. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: profileKeyParamsSchema,
    body: jsonRequest(
      updateProfileStatusRequestSchema,
      'The target status and expected current revision.',
      { status: 'deprecated', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(profileSummaryResponseSchema, 'The updated profile summary.', {
      ...profileSummaryExample,
      status: 'deprecated',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const getProfileVersionRoute = createRoute({
  method: 'get',
  path: '/api/v1/profiles/{key}/versions/{version}',
  operationId: 'getProfileVersion',
  tags: ['Profiles'],
  summary: 'Get a profile version',
  description: 'Returns one immutable profile version. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: profileVersionParamsSchema },
  responses: {
    200: jsonResponse(
      profileVersionResponseSchema,
      'The requested immutable profile version.',
      profileVersionExample,
    ),
    ...standardErrorResponses(),
  },
});

export function toProfileVersionResponse(profile: ProfileVersion) {
  return parseResponse(profileVersionResponseSchema, profile);
}

export function toProfileSummaryResponse(profile: ProfileSummary) {
  return parseResponse(profileSummaryResponseSchema, profile);
}

export function toProfileListResponse(profiles: ProfileSummary[]) {
  return parseResponse(profileListResponseSchema, {
    items: profiles.map(toProfileSummaryResponse),
  });
}
