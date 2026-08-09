import { OpenAPIHono, type OpenAPIHonoOptions } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';
import type { Actor } from '../domain/models/global-registry';
import { renderUiPage } from '../ui/app';
import { renderAccessRequiredPage } from '../ui/pages/access-required';
import type { ApiEnvironment } from './environment';
import { accessPrincipal, mappedActor, repository } from './environment';
import { actorMapping } from './middleware/actor-mapping';
import { accessPrincipal as accessPrincipalMiddleware } from './middleware/access-principal';
import { authorization } from './middleware/authorization';
import { registerErrorHandlers } from './middleware/errors';
import { mutationOrigin } from './middleware/mutation-origin';
import { requestContext } from './middleware/request-context';
import { registerActorRoutes } from './routes/actors';
import { registerAuthRoutes } from './routes/auth';
import { registerBindingRoutes } from './routes/bindings';
import { registerExportRoutes } from './routes/exports';
import { registerObservationRoutes } from './routes/observations';
import { registerOperationRoutes } from './routes/operations';
import { registerPolicyRoutes } from './routes/policies';
import { registerProfileRoutes } from './routes/profiles';
import { registerProviderRoutes } from './routes/providers';
import { registerRelationshipRoutes } from './routes/relationships';
import { registerResourceRoutes } from './routes/resources';
import {
  PayloadTooLargeError,
  AuthorizationError,
  RequestError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import { violationsDetails, zodViolations } from '../domain/errors/violations';
import { assertJsonValueLimits } from '../domain/models/json';
import { DOCS_CSS, DOCS_JS } from './docs-assets';
import { UI_CSS, UI_JS } from '../ui/assets';

const MAX_JSON_BODY_BYTES = 1_048_576;

const openApiConfiguration = {
  openapi: '3.1.0',
  info: {
    title: 'Global Registry API',
    version: '1.0.0',
    description:
      'Provider-neutral infrastructure control plane API. Cloudflare Access authenticates every request and Global Registry Actors authorize operations.',
  },
  tags: [
    { name: 'Authentication', description: 'Authenticated Access session information.' },
    { name: 'Actors', description: 'Global Registry authorization mappings.' },
    { name: 'Resources', description: 'Provider-neutral infrastructure resources.' },
    {
      name: 'Providers',
      description: 'Extensible provider drivers, capabilities, configuration, and mappings.',
    },
    { name: 'Profiles', description: 'Versioned resource specification profiles.' },
    { name: 'Policies', description: 'Versioned deterministic policy definitions.' },
    { name: 'Bindings', description: 'Resource to provider bindings.' },
    { name: 'Relationships', description: 'Relationships between resources.' },
    { name: 'Operations', description: 'Planned, fenced infrastructure operations.' },
    { name: 'Observations', description: 'Health and observation records.' },
    { name: 'Drift', description: 'Expected and observed state differences.' },
    { name: 'Audit', description: 'Immutable audit events.' },
    { name: 'Exports', description: 'Registry export records.' },
  ],
};

const openApiOptions: OpenAPIHonoOptions<ApiEnvironment> = {
  defaultHook: (result) => {
    if (!result.success) {
      const details = violationsDetails(zodViolations(result.error));
      if (result.target === 'json') {
        throw new ValidationError('invalid_request', 'Request body failed validation.', details);
      }
      throw new RequestError(
        result.target === 'query' ? 'invalid_query' : 'invalid_request',
        'Request parameters failed validation.',
        details,
      );
    }
  },
};

export function renderSwaggerUiDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Global Registry API reference" />
    <link rel="icon" href="data:," />
    <title>Global Registry API</title>
    <link rel="stylesheet" href="/docs/assets/api-docs.css" />
  </head>
  <body>
    <main class="swagger-ui">
      <div id="swagger-ui" data-openapi-url="/openapi.json"></div>
    </main>
    <script src="/docs/assets/api-docs.js" crossorigin="anonymous"></script>
  </body>
</html>`;
}

export function createApp(): OpenAPIHono<ApiEnvironment> {
  const app = new OpenAPIHono<ApiEnvironment>(openApiOptions);

  app.use('*', securityHeaders);
  app.use('*', requestContext);
  app.use('*', accessPrincipalMiddleware);
  app.use('*', mutationOrigin);
  app.use('*', actorMapping);
  app.use('/api/v1/*', actualJsonBodyLimit);

  app.get('/healthz', authorization(), (c) => c.json({ status: 'ok' }));
  app.get('/', (c) => c.redirect('/ui', 302));

  registerAuthRoutes(app);
  registerActorRoutes(app);
  registerResourceRoutes(app);
  registerProviderRoutes(app);
  registerProfileRoutes(app);
  registerPolicyRoutes(app);
  registerBindingRoutes(app);
  registerRelationshipRoutes(app);
  registerOperationRoutes(app);
  registerObservationRoutes(app);
  registerExportRoutes(app);

  app.use('/openapi.json', authorization());
  app.doc31('/openapi.json', openApiConfiguration);
  app.get('/docs', authorization(), (c) => c.html(renderSwaggerUiDocument()));
  app.get('/docs/assets/api-docs.css', authorization(), () => {
    return new Response(DOCS_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });
  });
  app.get('/docs/assets/api-docs.js', authorization(), () => {
    return new Response(DOCS_JS, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
    });
  });

  app.get('/ui/assets/app.css', () => {
    return new Response(UI_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });
  });
  app.get('/ui/assets/app.js', () => {
    return new Response(UI_JS, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
    });
  });

  app.get('/ui/access-required', (c) => {
    if (mappedActor(c) !== null) return c.redirect('/ui', 302);
    return c.html(renderAccessRequiredPage(accessPrincipal(c)));
  });
  app.get('/ui', renderUi);
  app.get('/ui/*', renderUi);

  app.openAPIRegistry.registerComponent('securitySchemes', 'CloudflareAccess', {
    type: 'apiKey',
    in: 'header',
    name: 'Cf-Access-Jwt-Assertion',
    description:
      'Cloudflare Access injects this application JWT at the edge. Browser users rely on the same-origin Access session and must not paste tokens into Swagger UI.',
  });

  app.openAPIRegistry.registerComponent('schemas', 'JsonValue', {
    description: 'A JSON value with maximum nesting depth 64 and maximum node count 10000.',
    oneOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'number' },
      { type: 'string' },
      { type: 'array', items: { $ref: '#/components/schemas/JsonValue' } },
      {
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/JsonValue' },
      },
    ],
  });

  registerErrorHandlers(app);
  return app;
}

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

const securityHeaders: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  await next();
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ui')) {
    c.header('Cache-Control', 'no-store');
  }
};

const actualJsonBodyLimit: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const request = c.req.raw;
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new RequestError(
        'invalid_content_length',
        'Content-Length must be a non-negative integer.',
      );
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_JSON_BODY_BYTES) {
      throw new PayloadTooLargeError('JSON request bodies are limited to 1 MiB.');
    }
  }

  if (request.body === null) {
    await next();
    return;
  }

  const contentType = request.headers.get('content-type');
  if (contentType === null || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new UnsupportedMediaTypeError();
  }

  const reader = request.clone().body?.getReader();
  if (reader === undefined) {
    throw new PayloadTooLargeError('The request body could not be bounded.');
  }
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError('JSON request bodies are limited to 1 MiB.');
      }
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const parsed: unknown = await request.clone().json();
    assertJsonValueLimits(parsed, 'request body');
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new RequestError('invalid_json', 'Request body must contain valid JSON.');
  }
  await next();
};

async function renderUi(c: Context<ApiEnvironment>) {
  const mapped = mappedActor(c);
  if (mapped === null) return c.redirect('/ui/access-required', 302);

  const url = new URL(c.req.url);
  requireUiRole(mapped, url.pathname);
  const html = await renderUiPage({
    pathname: url.pathname,
    searchParams: url.searchParams,
    actor: mapped,
    repository: repository(c),
  });
  if (html === null) {
    const notFoundHtml = await renderUiPage({
      pathname: '/ui/not-found',
      searchParams: new URLSearchParams(),
      actor: mapped,
      repository: repository(c),
    });
    return c.html(
      notFoundHtml ??
        '<!doctype html><html lang="ja"><title>404</title><p>ページが見つかりません。</p></html>',
      404,
    );
  }
  return c.html(html);
}

function requireUiRole(mapped: Actor, pathname: string): void {
  if (pathname === '/ui/access' || pathname.startsWith('/ui/access/')) {
    if (mapped.role !== 'admin') {
      throw new AuthorizationError('forbidden', 'Only administrators can use access management.');
    }
  }
}

export function createOpenApiDocument(
  app: OpenAPIHono<ApiEnvironment> = createApp(),
): ReturnType<OpenAPIHono<ApiEnvironment>['getOpenAPI31Document']> {
  return app.getOpenAPI31Document(openApiConfiguration);
}
