import { OpenAPIHono } from '@hono/zod-openapi';
import { ZodError } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { authenticateAccessPrincipal } from '../auth/access';
import { AuthorizationError, GlobalRegistryError } from './errors';
import type { ApiEnvironment } from '../db/types';
import { registerRoutes } from './routes';
import { shell, client, styles } from '../ui/app';
export const app = new OpenAPIHono<ApiEnvironment>({
  defaultHook: (result, c) => {
    if (!result.success)
      return c.json(
        {
          code: 'validation_error',
          message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        400,
      );
  },
});
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'no-referrer',
  }),
);
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json({ code: 'validation_error', message: 'Request body exceeds 64 KiB.' }, 400),
  }),
);
app.use('*', async (c, next) => {
  const isShell =
    c.req.method === 'GET' && !c.req.path.startsWith('/api/') && c.req.path !== '/openapi.json';
  let request = c.req.raw;
  if (isShell && c.env.ENVIRONMENT === 'development' && c.env.ALLOW_LOCAL_AUTH === 'true') {
    // The development shell contains no inventory or secrets. Data requests still require the local secret.
    const headers = new Headers(request.headers);
    headers.set('x-global-registry-dev-secret', c.env.LOCAL_AUTH_SECRET);
    request = new Request(request, { headers });
  }
  c.set('actor', (await authenticateAccessPrincipal(request, c.env)).identity);
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (
      c.req.header('sec-fetch-site') === 'cross-site' ||
      (origin !== undefined && origin !== new URL(c.req.url).origin)
    )
      throw new AuthorizationError(
        'cross_site_mutation',
        'Browser mutations must use the same origin.',
      );
    if (
      ['POST', 'PATCH', 'PUT'].includes(c.req.method) &&
      c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return c.json({ code: 'validation_error', message: 'Use application/json.' }, 400);
  }
  await next();
});
registerRoutes(app);
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Global Registry API',
    version: '1.0.0',
    description:
      'Infrastructure inventory and IPAM. All routes require a verified Cloudflare Access application JWT. Service clients authenticate to Access with Service Token headers.',
  },
  security: [{ AccessClientId: [], AccessClientSecret: [] }, { AccessSession: [] }],
});
app.openAPIRegistry.registerComponent('securitySchemes', 'AccessClientId', {
  type: 'apiKey',
  in: 'header',
  name: 'CF-Access-Client-Id',
  description:
    'Service Token client ID sent to the Access gateway together with CF-Access-Client-Secret.',
});
app.openAPIRegistry.registerComponent('securitySchemes', 'AccessClientSecret', {
  type: 'apiKey',
  in: 'header',
  name: 'CF-Access-Client-Secret',
  description: 'Service Token secret sent to the Access gateway together with CF-Access-Client-Id.',
});
app.openAPIRegistry.registerComponent('securitySchemes', 'AccessSession', {
  type: 'apiKey',
  in: 'cookie',
  name: 'CF_Authorization',
  description:
    'Browser session established by signing in through Cloudflare Access. Access injects the origin-facing Cf-Access-Jwt-Assertion header; clients do not generate that header.',
});
app.get('/assets/app.js', (c) =>
  c.body(client, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }),
);
app.get('/assets/app.css', (c) =>
  c.body(styles, 200, { 'Content-Type': 'text/css; charset=utf-8' }),
);
app.get('/', (c) => c.html(shell));
app.get('/docs', (c) => c.html(shell));
for (const path of [
  'locations',
  'devices',
  'virtual-machines',
  'interfaces',
  'vlans',
  'prefixes',
  'ip-addresses',
  'audit-log',
]) {
  app.get(`/${path}`, (c) => c.html(shell));
  app.get(`/${path}/:id`, (c) => c.html(shell));
}
app.notFound((c) => c.json({ code: 'not_found', message: 'Route not found.' }, 404));
app.onError((error, c) => {
  if (error instanceof GlobalRegistryError)
    return c.json({ code: error.code, message: error.message }, error.status);
  if (error instanceof ZodError)
    return c.json(
      { code: 'validation_error', message: error.issues.map((i) => i.message).join('; ') },
      400,
    );
  if (error instanceof HTTPException && error.status === 400)
    return c.json({ code: 'validation_error', message: 'Malformed JSON request.' }, 400);
  console.error('Request failed', error instanceof Error ? error.name : 'UnknownError');
  return c.json({ code: 'internal_error', message: 'An unexpected error occurred.' }, 500);
});
