import type { PrincipalType } from '../../domain/actor/identity';
import { escapeHtml, principalTypeLabel } from '../format';

export function renderAccessRequiredPage(input: { identity: string; type: PrincipalType }): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/ui/assets/app.css" />
    <title>アクセス登録が必要です | Global Registry</title>
  </head>
  <body>
    <main class="standalone">
      <div class="standalone-main">
        <h1>アクセス登録が必要です</h1>
        <p>Global Registryへのアクセスはまだ登録されていません。以下のIdentityを管理者へ送ってください。</p>
        <section class="identity-card" aria-labelledby="identity-title">
          <h2 class="section-title" id="identity-title">あなたのIdentity</h2>
          <dl class="kv">
            <dt>正規化済みIdentity</dt>
            <dd><code class="identity-value" id="canonical-identity">${escapeHtml(input.identity)}</code></dd>
            <dt>利用者種別</dt>
            <dd>${escapeHtml(principalTypeLabel(input.type))}</dd>
          </dl>
          <div class="form-actions">
            <button class="button" type="button" data-copy-target="canonical-identity" data-copy-status="copy-status">Identityをコピー</button>
          </div>
          <div class="form-status" id="copy-status" role="status" aria-live="polite"></div>
        </section>
      </div>
    </main>
    <script type="module" src="/ui/assets/app.js"></script>
  </body>
</html>`;
}
