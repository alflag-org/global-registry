import { ACTOR_ROLES } from '../../domain/models/global-registry';
import { renderFormStatus, renderInput, renderSelect } from '../components/form';
import { renderPageHeader } from '../components/layout';
import { renderNotice } from '../components/notice';
import { actorRoleLabels } from '../format';
import type { UiPageContent } from './types';

export function renderAccessCreatePage(): UiPageContent {
  return {
    title: 'Actor登録',
    body: `${renderPageHeader('Actor登録', 'Global Registryへcanonical identityを登録します。')}
      <div class="stack">
        ${renderNotice(
          'Cloudflare AccessのService Token secretやcredentialは入力しないでください。必要なのはcanonical identityだけです。',
          { tone: 'warning' },
        )}
        <form class="form-grid" action="/api/v1/actors" method="post" data-api-form data-api-method="POST" data-success-path="/ui/access/{id}">
          ${renderInput({
            id: 'actor-identity',
            name: 'identity',
            label: 'Identity',
            required: true,
            maxLength: 256,
            autocomplete: 'off',
            pattern: '(?:access|service):(?:\\S|\\S.*\\S)',
            title:
              'access: または service: で始まり、prefixの後に空白以外の文字を入力してください。',
            description:
              '人間は access:<Cloudflare Access subject>、Service Tokenは service:<common_name> を貼り付けます。',
            placeholder: 'access:… または service:…',
          })}
          ${renderInput({
            id: 'actor-display-name',
            name: 'displayName',
            label: '表示名',
            required: true,
            maxLength: 128,
            autocomplete: 'off',
          })}
          ${renderSelect({
            id: 'actor-role',
            name: 'role',
            label: 'ロール',
            required: true,
            selected: 'readonly',
            options: ACTOR_ROLES.map((role) => ({
              value: role,
              label: actorRoleLabels[role],
            })),
          })}
          <div class="form-actions">
            <button class="button" type="submit">登録する</button>
            <a class="button button-secondary" href="/ui/access">キャンセル</a>
          </div>
          ${renderFormStatus()}
        </form>
      </div>`,
  };
}
