export const DOCS_CSS = `
:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { margin: 0; background: #f7f8fa; color: #202124; }
main { max-width: 1100px; margin: 0 auto; padding: 2rem; }
.swagger-ui h1 { margin-top: 0; font-size: 2rem; }
.swagger-ui .description { color: #5f6368; }
.swagger-ui .tag { margin-top: 2rem; }
.swagger-ui .operation { margin: .75rem 0; padding: 1rem; background: white; border: 1px solid #dadce0; border-radius: .5rem; }
.swagger-ui .method { display: inline-block; min-width: 4rem; margin-right: .75rem; font-weight: 700; text-transform: uppercase; }
.swagger-ui .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.swagger-ui .error { color: #a50e0e; }
`;

export const DOCS_JS = `
(function () {
  'use strict';
  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character];
    });
  }
  function render(documentData) {
    var root = document.getElementById('swagger-ui');
    if (!root) return;
    var html = '<h1>' + escapeHtml(documentData.info && documentData.info.title || 'API') + '</h1>';
    html += '<p class="description">' + escapeHtml(documentData.info && documentData.info.description || '') + '</p>';
    var paths = documentData.paths || {};
    Object.keys(paths).sort().forEach(function (path) {
      var operations = paths[path] || {};
      Object.keys(operations).sort().forEach(function (method) {
        var operation = operations[method] || {};
        var tag = operation.tags && operation.tags[0] || 'Operations';
        var section = document.getElementById('tag-' + tag);
        if (!section) {
          section = document.createElement('section');
          section.className = 'tag';
          section.id = 'tag-' + tag;
          section.innerHTML = '<h2>' + escapeHtml(tag) + '</h2>';
          root.appendChild(section);
        }
        var item = document.createElement('div');
        item.className = 'operation';
        item.innerHTML = '<span class="method">' + escapeHtml(method) + '</span><span class="path">' + escapeHtml(path) + '</span><p>' + escapeHtml(operation.summary || '') + '</p>';
        section.appendChild(item);
      });
    });
  }
  window.SwaggerUIBundle = function (configuration) {
    return fetch(configuration.url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('The OpenAPI document could not be loaded.');
        return response.json();
      })
      .then(render)
      .catch(function (error) {
        var root = document.getElementById('swagger-ui');
        if (root) root.innerHTML = '<p class="error">' + escapeHtml(error.message) + '</p>';
        throw error;
      });
  };
  document.addEventListener('DOMContentLoaded', function () {
    var root = document.getElementById('swagger-ui');
    window.SwaggerUIBundle({ url: root && root.dataset.openapiUrl || '/openapi.json' });
  });
}());
`;
