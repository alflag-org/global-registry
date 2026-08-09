import type { ResourceDetail } from '../../application/ports';
import { lifecycleTransitions } from '../../domain/lifecycle/lifecycle';
import type {
  Actor,
  AuditEvent,
  Resource,
  ResourceKindDefinitionVersion,
} from '../../domain/models/global-registry';
import { renderFormStatus, renderSelect } from '../components/form';
import {
  renderDefinitionList,
  renderEmpty,
  renderPageHeader,
  renderSection,
} from '../components/layout';
import { renderNotice } from '../components/notice';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, escapeHtmlAttribute, formatDate, labelValue, pathSegment } from '../format';
import type { UiPageContent } from './types';

function renderRelationshipTable(
  detail: ResourceDetail,
  resourcesById: ReadonlyMap<string, Resource>,
): string {
  if (detail.relationships.length === 0) return renderEmpty('関連するリソースはありません。');
  return renderTable({
    label: '関連するリソース',
    columns: [{ label: '関係' }, { label: 'リソース' }],
    rows: detail.relationships.map((relationship) => {
      const otherId =
        relationship.sourceResourceId === detail.resource.id
          ? relationship.targetResourceId
          : relationship.sourceResourceId;
      return [
        { text: labelValue(relationship.relationshipType) },
        { text: resourcesById.get(otherId)?.key ?? otherId, className: 'mono' },
      ];
    }),
  });
}

function renderLifecycleForm(
  actor: Actor,
  resource: Resource,
  definition: ResourceKindDefinitionVersion,
): string {
  if (actor.role !== 'provisioner' && actor.role !== 'operator') {
    return renderNotice('操作の作成にはプロビジョナーまたはオペレーター権限が必要です。');
  }
  const transitions = lifecycleTransitions(definition, resource.lifecycleState);
  if (transitions.length === 0) return renderEmpty('遷移可能な状態はありません。');
  return `<form class="form-grid" action="/api/v1/operations" method="post" data-operation-form data-resource-key="${escapeHtmlAttribute(resource.key)}" data-source-state="${escapeHtmlAttribute(resource.lifecycleState)}" data-resource-revision="${resource.revision}">
    ${renderSelect({
      id: 'target-state',
      name: 'targetState',
      label: '変更先の状態',
      options: transitions.map((transition) => ({
        value: transition.to,
        label: labelValue(transition.to),
      })),
      required: true,
    })}
    <div class="form-actions">
      <button class="button" type="submit">操作を作成</button>
    </div>
    ${renderFormStatus('operation-form-status')}
  </form>`;
}

export function renderResourceDetailPage(input: {
  detail: ResourceDetail;
  allResources: readonly Resource[];
  events: readonly AuditEvent[];
  actor: Actor;
  definition: ResourceKindDefinitionVersion;
  query: { relationshipCursor?: string; driftCursor?: string };
}): UiPageContent {
  const { detail, events } = input;
  const { resource } = detail;
  const resourcesById = new Map(input.allResources.map((item) => [item.id, item]));
  const health = detail.health ?? { status: 'unknown', revision: 0, reason: '' };
  const binding = detail.binding;
  const detailPath = `/ui/resources/${pathSegment(resource.key)}`;
  const relationshipNext =
    detail.relationshipsNextCursor === undefined
      ? ''
      : `<a class="button button-secondary" href="${detailPath}?relationshipCursor=${pathSegment(detail.relationshipsNextCursor)}${input.query.driftCursor === undefined ? '' : `&driftCursor=${pathSegment(input.query.driftCursor)}`}">関係の次のページ</a>`;
  const driftNext =
    detail.driftsNextCursor === undefined
      ? ''
      : `<a class="button button-secondary" href="${detailPath}?driftCursor=${pathSegment(detail.driftsNextCursor)}${input.query.relationshipCursor === undefined ? '' : `&relationshipCursor=${pathSegment(input.query.relationshipCursor)}`}">ドリフトの次のページ</a>`;
  const driftContent =
    detail.drifts.length === 0
      ? renderEmpty('ドリフトはありません。')
      : renderTable({
          label: 'リソースのドリフト',
          columns: [
            { label: 'ドリフト' },
            { label: '重要度' },
            { label: '状態' },
            { label: 'リビジョン' },
          ],
          rows: detail.drifts.map((drift) => [
            { text: drift.id, className: 'mono' },
            { html: renderStatus(drift.severity) },
            { html: renderStatus(drift.status) },
            { text: `r${drift.revision}`, className: 'mono' },
          ]),
        });
  const eventContent =
    events.length === 0
      ? renderEmpty('監査イベントはありません。')
      : renderTable({
          label: 'リソースの監査ログ',
          columns: [{ label: '発生日時' }, { label: '種別' }, { label: '実行者' }],
          rows: events.slice(0, 12).map((event) => [
            { text: formatDate(event.occurredAt) },
            {
              html: `${escapeHtml(labelValue(event.eventType))}<div class="status-sub mono">${escapeHtml(event.eventType)}</div>`,
            },
            { text: event.actorId, className: 'mono' },
          ]),
        });
  return {
    title: resource.key,
    body: `${renderPageHeader(
      resource.key,
      `${resource.name} · ${labelValue(resource.kind)} v${resource.kindVersion} · r${resource.revision}`,
    )}
      <div class="stack">
        ${renderSection(
          '状態',
          '',
          renderDefinitionList([
            { term: 'ライフサイクル', descriptionHtml: renderStatus(resource.lifecycleState) },
            {
              term: 'ヘルス',
              descriptionHtml: `${renderStatus(health.status)}${
                health.reason ? `<div class="status-sub">${escapeHtml(health.reason)}</div>` : ''
              }`,
            },
            { term: '更新日時', descriptionText: formatDate(resource.updatedAt) },
            {
              term: 'プロバイダー紐付け',
              descriptionHtml:
                binding === null
                  ? '未紐付け'
                  : `<span class="mono">${escapeHtml(binding.providerId)} / ${escapeHtml(binding.providerResourceId)}</span>`,
            },
          ]),
        )}
        ${renderSection('操作', '', renderLifecycleForm(input.actor, resource, input.definition))}
        ${renderSection('ドリフト', `${detail.drifts.length}${detail.driftsNextCursor === undefined ? '' : '+'}件`, driftContent + (driftNext === '' ? '' : `<p>${driftNext}</p>`))}
        ${renderSection(
          '関係',
          `${detail.relationships.length}${detail.relationshipsNextCursor === undefined ? '' : '+'}件`,
          renderRelationshipTable(detail, resourcesById) +
            (relationshipNext === '' ? '' : `<p>${relationshipNext}</p>`),
        )}
        ${renderSection(
          '仕様',
          '',
          `<pre class="json">${escapeHtml(
            JSON.stringify(
              {
                placement: resource.placement,
                specOverrides: resource.specOverrides,
                spec: resource.spec,
                profile: resource.profile ?? null,
                policy: resource.policy ?? null,
              },
              null,
              2,
            ),
          )}</pre>`,
        )}
        ${renderSection('監査ログ', `${events.length}件`, eventContent)}
      </div>`,
  };
}
