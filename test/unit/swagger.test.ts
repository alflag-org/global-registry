import { describe, expect, it } from 'vitest';
import { renderSwaggerUiDocument } from '../../src/api/app';

describe('Self-hosted API documentation viewer', () => {
  it('renders a self-hosted documentation viewer against the generated document endpoint', () => {
    const html = renderSwaggerUiDocument();

    expect(html).toContain('<title>Global Registry API</title>');
    expect(html).toContain('/openapi.json');
    expect(html).toContain('/docs/assets/api-docs.css');
    expect(html).toContain('/docs/assets/api-docs.js');
    expect(html).not.toContain('https://cdn.jsdelivr.net');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('data-try-it-out');
  });

  it('keeps the self-hosted viewer initialization in the pinned local asset', async () => {
    const { DOCS_JS } = await import('../../src/api/docs-assets');

    expect(DOCS_JS).toContain('SwaggerUIBundle');
    expect(DOCS_JS).toContain('fetch(configuration.url,');
    expect(DOCS_JS).toContain('window.SwaggerUIBundle');
  });
});
