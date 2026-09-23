// Swagger UI assets are embedded as text (wrangler "Text" module rule) and served
// same-origin so the strict CSP stays in force; /docs relaxes style-src only.
import swaggerJs from 'swagger-ui-dist/swagger-ui-bundle.js';
import swaggerCss from 'swagger-ui-dist/swagger-ui.css';

export { swaggerJs, swaggerCss };

export const swaggerInit = String.raw`
window.addEventListener('load', () => {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: -1,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    // Local development: reuse the secret stored by the shell's auth dialog.
    // In production the Cloudflare Access session authorizes these requests.
    requestInterceptor: (req) => {
      const secret = sessionStorage.getItem('registry-local-secret');
      if (secret) req.headers['x-global-registry-dev-secret'] = secret;
      return req;
    },
  });
});
`;

export const docsPage = String.raw`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Global Registry — API documentation</title>
    <link rel="stylesheet" href="/assets/swagger-ui.css" />
    <style>
      body {
        margin: 0;
        font-family: system-ui, sans-serif;
        background: #f4f7f9;
      }
      .docs-header {
        background: #122c3d;
        padding: 12px 28px;
        display: flex;
        align-items: baseline;
        gap: 14px;
      }
      .docs-header a.brand {
        color: #fff;
        text-decoration: none;
        font-weight: 750;
        font-size: 17px;
      }
      .docs-header span {
        color: #90adbf;
        font-size: 13px;
      }
      .swagger-ui .topbar {
        display: none;
      }
    </style>
  </head>
  <body>
    <header class="docs-header">
      <a class="brand" href="/">Global Registry</a>
      <span>API documentation</span>
    </header>
    <div id="swagger-ui"></div>
    <script src="/assets/swagger-ui.js"></script>
    <script src="/assets/swagger-init.js"></script>
  </body>
</html>
`;
