import type { Actor } from '../domain/models/global-registry';
import { actorRoleLabels, escapeHtml, escapeHtmlAttribute } from './format';
import { renderNavigation } from './navigation';

interface ShellOptions {
  actor: Actor;
  currentPath: string;
  body: string;
  title: string;
}

export function renderShell(options: ShellOptions): string {
  const actorName = escapeHtml(options.actor.displayName);
  const actorRole = escapeHtml(options.actor.role);
  const actorRoleLabel = escapeHtml(actorRoleLabels[options.actor.role]);
  const title = escapeHtml(options.title);
  const documentTitle =
    options.currentPath === '/ui' ? 'Global Registry' : `${title} | Global Registry`;
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/ui/assets/app.css" />
    <title>${documentTitle}</title>
  </head>
  <body>
    <a class="skip-link" href="#main-content">本文へ移動</a>
    <div class="shell">
      <aside class="rail" aria-label="Global Registry メインナビゲーション">
        <div class="brand">Global Registry</div>
        <nav class="nav">
          ${renderNavigation(options.actor, options.currentPath)}
        </nav>
        <div class="rail-footer">
          <div class="actor-name">${actorName}</div>
          <div class="actor-meta">${actorRoleLabel} · ${actorRole}</div>
        </div>
      </aside>
      <main class="workspace" id="main-content" tabindex="-1">
        ${options.body}
      </main>
    </div>
    <script type="module" src="/ui/assets/app.js"></script>
  </body>
</html>`;
}

export function renderActionLink(path: string, label: string): string {
  return `<a class="button" href="${escapeHtmlAttribute(path)}">${escapeHtml(label)}</a>`;
}
