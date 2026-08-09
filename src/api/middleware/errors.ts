import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GlobalRegistryError } from '../../domain/errors/global-registry-error';
import type { ApiEnvironment } from '../environment';

export function registerErrorHandlers(app: Hono<ApiEnvironment>): void {
  app.notFound((c) =>
    c.json(
      {
        error: { code: 'not_found', message: 'Route not found.' },
        requestId: c.get('requestId'),
      },
      404,
    ),
  );

  app.onError((error, c) => {
    const requestId = c.get('requestId');
    if (error instanceof HTTPException && error.status === 400) {
      return c.json(
        {
          error: { code: 'invalid_json', message: 'Request body must be valid JSON.' },
          requestId,
        },
        400,
      );
    }
    if (error instanceof GlobalRegistryError) {
      const violations = error.details?.violations;
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(Array.isArray(violations) ? { violations } : {}),
          },
          requestId,
        },
        error.status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 503,
      );
    }
    console.error(
      JSON.stringify({
        message: 'unhandled request error',
        requestId,
        route: new URL(c.req.url).pathname,
        errorClass: error instanceof Error ? error.name : 'unknown',
        errorMessage: 'redacted',
      }),
    );
    return c.json(
      {
        error: { code: 'internal_error', message: 'Unexpected server error.' },
        requestId,
      },
      500,
    );
  });
}
