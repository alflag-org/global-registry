import { principalTypeFromIdentity } from '../../domain/actor/identity';
import { ACTOR_ROLES, type Actor } from '../../domain/models/global-registry';
import { renderInput, renderSelect } from '../components/form';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import {
  actorRoleLabels,
  escapeHtml,
  formatDate,
  pathSegment,
  principalTypeLabel,
} from '../format';
import { renderActionLink } from '../shell';
import type { UiPageContent } from './types';

export function renderAccessListPage(input: {
  actors: readonly Actor[];
  searchParams: URLSearchParams;
}): UiPageContent {
  const search = input.searchParams.get('q')?.trim() ?? '';
  const role = input.searchParams.get('role') ?? '';
  const status = input.searchParams.get('status') ?? '';
  const principalType = input.searchParams.get('principalType') ?? '';
  const normalizedSearch = search.toLocaleLowerCase('ja-JP');
  const actors = input.actors.filter((actor) => {
    const type = principalTypeFromIdentity(actor.identity);
    if (role.length > 0 && actor.role !== role) return false;
    if (status === 'active' && !actor.active) return false;
    if (status === 'inactive' && actor.active) return false;
    if (principalType.length > 0 && type !== principalType) return false;
    if (
      normalizedSearch.length > 0 &&
      !actor.displayName.toLocaleLowerCase('ja-JP').includes(normalizedSearch) &&
      !actor.identity.toLocaleLowerCase('ja-JP').includes(normalizedSearch)
    ) {
      return false;
    }
    return true;
  });
  const table = renderTable({
    label: 'Actor一覧',
    columns: [
      { label: '表示名' },
      { label: 'Identity' },
      { label: '主体種別' },
      { label: 'ロール' },
      { label: '状態' },
      { label: 'リビジョン' },
      { label: '作成日時' },
      { label: '更新日時' },
    ],
    rows: actors.map((actor) => [
      {
        html: `<a class="row-link" href="/ui/access/${pathSegment(actor.id)}">${escapeHtml(actor.displayName)}</a>`,
      },
      { text: actor.identity, className: 'mono' },
      { text: principalTypeLabel(principalTypeFromIdentity(actor.identity)) },
      { text: actorRoleLabels[actor.role] },
      { html: renderStatus(actor.active ? 'active' : 'inactive') },
      { text: `r${actor.revision}`, className: 'mono' },
      { text: formatDate(actor.createdAt) },
      { text: formatDate(actor.updatedAt) },
    ]),
    emptyMessage: '条件に一致するActorはありません。',
  });
  const filterForm = `<form class="filter-form" action="/ui/access" method="get">
    <div class="filter-grid">
      <div>
        ${renderInput({
          id: 'access-search',
          name: 'q',
          type: 'search',
          label: '表示名またはIdentityを検索',
          value: search,
          placeholder: '表示名またはcanonical identity',
        })}
      </div>
      <div>
        ${renderSelect({
          id: 'access-role-filter',
          name: 'role',
          label: 'ロール',
          selected: role,
          options: [
            { value: '', label: 'すべて' },
            ...ACTOR_ROLES.map((value) => ({ value, label: actorRoleLabels[value] })),
          ],
        })}
      </div>
      <div>
        ${renderSelect({
          id: 'access-status-filter',
          name: 'status',
          label: '状態',
          selected: status,
          options: [
            { value: '', label: 'すべて' },
            { value: 'active', label: '有効' },
            { value: 'inactive', label: '無効' },
          ],
        })}
      </div>
      <div>
        ${renderSelect({
          id: 'access-principal-filter',
          name: 'principalType',
          label: '主体種別',
          selected: principalType,
          options: [
            { value: '', label: 'すべて' },
            { value: 'human', label: '人間' },
            { value: 'service', label: 'サービス' },
          ],
        })}
      </div>
    </div>
    <div class="form-actions">
      <button class="button" type="submit">絞り込む</button>
      <a class="button button-secondary" href="/ui/access">条件をクリア</a>
    </div>
  </form>`;
  return {
    title: 'アクセス管理',
    body: `${renderPageHeader(
      'アクセス管理',
      `${actors.length}件表示 / ${input.actors.length}件`,
      `<div class="page-actions">${renderActionLink('/ui/access/new', 'Actorを登録')}</div>`,
    )}
      ${filterForm}
      <div class="access-table">${table}</div>`,
  };
}
