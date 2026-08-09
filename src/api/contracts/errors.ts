import { z } from '@hono/zod-openapi';
import { jsonResponse } from './common';

const domainViolationSchema = z
  .object({
    code: z.string().min(1),
    path: z.string(),
    message: z.string().min(1),
  })
  .strict()
  .openapi('DomainViolation');

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        violations: z.array(domainViolationSchema).optional(),
      })
      .strict(),
    requestId: z.string().uuid(),
  })
  .strict()
  .openapi('ErrorResponse');

const examples = {
  400: {
    error: { code: 'invalid_request', message: 'Request validation failed.' },
    requestId: '7d368960-60e6-4275-9d2f-c8db963d21d8',
  },
  401: {
    error: { code: 'access_required', message: 'Cloudflare Access authentication is required.' },
    requestId: 'd96061a3-e2f7-4890-8c14-29f10e9a9c0c',
  },
  403: {
    error: {
      code: 'forbidden',
      message: 'The mapped actor cannot perform this operation.',
    },
    requestId: 'f87dfaed-3377-4ce3-bc4b-571b5798d1c9',
  },
  404: {
    error: { code: 'not_found', message: 'The requested entity was not found.' },
    requestId: '11811fcf-c7b7-4f89-81fe-d0a2a737ec0f',
  },
  409: {
    error: { code: 'revision_conflict', message: 'The expected revision is stale.' },
    requestId: '34687967-47d0-4de2-89e8-3ef67e681574',
  },
  413: {
    error: { code: 'request_too_large', message: 'The request body is too large.' },
    requestId: 'a35bd667-61b4-4a5e-8a21-427d08bbd3ac',
  },
  415: {
    error: {
      code: 'unsupported_media_type',
      message: 'JSON request bodies must use application/json.',
    },
    requestId: 'f48dfc31-9533-4c89-a8a8-df8d53a3b8d4',
  },
  422: {
    error: {
      code: 'provider_incompatible',
      message: 'The provider cannot satisfy this resource.',
      violations: [
        {
          code: 'missing_resource_capability',
          path: 'provider.capabilities.features',
          message: 'The selected provider does not declare a required capability.',
        },
      ],
    },
    requestId: '47bc25da-c9e0-437f-9e17-9156aee43bdc',
  },
  503: {
    error: {
      code: 'access_keys_unavailable',
      message: 'Cloudflare Access signing keys are unavailable.',
    },
    requestId: '2b0b4c06-b41a-4cb8-b39d-86f0a027db18',
  },
} as const;

export function standardErrorResponses() {
  return {
    400: jsonResponse(
      errorResponseSchema,
      'The request is malformed or fails HTTP validation.',
      examples[400],
    ),
    401: jsonResponse(
      errorResponseSchema,
      'Cloudflare Access authentication failed.',
      examples[401],
    ),
    403: jsonResponse(
      errorResponseSchema,
      'Actor mapping, activity, or role authorization failed.',
      examples[403],
    ),
    404: jsonResponse(
      errorResponseSchema,
      'A referenced or requested entity does not exist.',
      examples[404],
    ),
    409: jsonResponse(
      errorResponseSchema,
      'A revision, lifecycle, operation, lock, or fencing conflict occurred.',
      examples[409],
    ),
    413: jsonResponse(
      errorResponseSchema,
      'The request body exceeded the application limit.',
      examples[413],
    ),
    415: jsonResponse(
      errorResponseSchema,
      'The request body media type is not supported.',
      examples[415],
    ),
    422: jsonResponse(
      errorResponseSchema,
      'Domain validation, policy evaluation, or provider compatibility failed.',
      examples[422],
    ),
    503: jsonResponse(
      errorResponseSchema,
      'Cloudflare Access configuration or signing-key retrieval failed.',
      examples[503],
    ),
  } as const;
}
