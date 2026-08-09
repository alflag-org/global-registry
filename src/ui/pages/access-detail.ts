import { principalTypeFromIdentity } from '../../domain/actor/identity';
import { ACTOR_ROLES, type Actor } from '../../domain/models/global-registry';
import { renderCheckbox, renderFormStatus, renderInput, renderSelect } from '../components/form';
import { renderDefinitionList, renderPageHeader, renderSection } from '../components/layout';
import { renderNotice } from '../components/notice';
import { renderStatus } from '../components/status';
import { actorRoleLabels, escapeHtmlAttribute, formatDate, principalTypeLabel } from '../format';
import type { UiPageContent } from './types';

export function renderAccessDetailPage(input: {
  actor: Actor;
  currentActor: Actor;
}): UiPageContent {
  const self = input.actor.id === input.currentActor.id;
  const warnings = [
    input.actor.role === 'admin'
      ? renderNotice(
          '管理者権限を解除する変更は、別の有効な管理者が存在する場合だけ保存できます。',
          { tone: 'warning' },
        )
      : '',
    self
      ? renderNotice(
          'これは現在の自分自身のActorです。権限変更または無効化は自己ロックアウト防止の対象です。',
          { tone: 'warning' },
        )
      : '',
  ].join('');
  const details = renderDefinitionList([
    { term: 'Identity', descriptionText: input.actor.identity },
    {
      term: '主体種別',
      descriptionText: principalTypeLabel(principalTypeFromIdentity(input.actor.identity)),
    },
    {
      term: '状態',
      descriptionHtml: renderStatus(input.actor.active ? 'active' : 'inactive'),
    },
    { term: 'リビジョン', descriptionText: `r${input.actor.revision}` },
    { term: '作成日時', descriptionText: formatDate(input.actor.createdAt) },
    { term: '更新日時', descriptionText: formatDate(input.actor.updatedAt) },
  ]);
  return {
    title: input.actor.displayName,
    body: `${renderPageHeader(input.actor.displayName, input.actor.identity)}
      <div class="stack">
        ${renderSection('登録情報', '', details)}
        <section class="section" aria-labelledby="actor-edit-title">
          <div class="section-head"><h2 class="section-title" id="actor-edit-title">変更</h2></div>
          ${warnings}
          <form class="form-grid" action="/api/v1/actors/${escapeHtmlAttribute(input.actor.id)}" method="post" data-api-form data-api-method="PATCH" data-success-path="/ui/access/{id}" data-access-detail-form data-original-role="${escapeHtmlAttribute(input.actor.role)}" data-original-active="${input.actor.active ? 'true' : 'false'}" data-target-actor-id="${escapeHtmlAttribute(input.actor.id)}" data-current-actor-id="${escapeHtmlAttribute(input.currentActor.id)}">
            ${renderInput({
              id: 'actor-display-name',
              name: 'displayName',
              label: '表示名',
              value: input.actor.displayName,
              required: true,
              maxLength: 128,
              autocomplete: 'off',
            })}
            ${renderSelect({
              id: 'actor-role',
              name: 'role',
              label: 'ロール',
              required: true,
              selected: input.actor.role,
              options: ACTOR_ROLES.map((role) => ({
                value: role,
                label: actorRoleLabels[role],
              })),
              description: '管理者権限の解除は送信前に確認します。',
            })}
            ${renderCheckbox({
              id: 'actor-active',
              name: 'active',
              label: 'このActorを有効にする',
              checked: input.actor.active,
              description: '無効化すると、このIdentityはGlobal Registryを利用できなくなります。',
            })}
            <input type="hidden" name="expectedRevision" value="${input.actor.revision}" data-json-type="number" />
            <div class="form-actions">
              <button class="button" type="submit">変更を保存</button>
              <a class="button button-secondary" href="/ui/access">一覧へ戻る</a>
            </div>
            ${renderFormStatus()}
          </form>
          <p class="form-help">Actorは削除しません。利用を止める場合は無効化してください。</p>
        </section>
      </div>`,
  };
}
