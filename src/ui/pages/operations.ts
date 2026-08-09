import type { OperationDetail } from '../../application/operations';
import type { Operation } from '../../domain/models/global-registry';
import {
  renderDefinitionList,
  renderEmpty,
  renderPageHeader,
  renderSection,
} from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, labelValue, pathSegment } from '../format';
import type { UiPageContent } from './types';

export function renderOperationsPage(operations: readonly Operation[]): UiPageContent {
  return {
    title: '操作',
    body:
      renderPageHeader('操作', `${operations.length}件`) +
      renderTable({
        label: '操作一覧',
        columns: [
          { label: '操作' },
          { label: '種別' },
          { label: '状態' },
          { label: '計画ハッシュ' },
          { label: '作成日時' },
        ],
        rows: operations.map((operation) => [
          {
            html: `<a class="row-link mono" href="/ui/operations/${pathSegment(operation.id)}">${escapeHtml(operation.id)}</a>`,
          },
          { text: labelValue(operation.kind) },
          { html: renderStatus(operation.status) },
          {
            text:
              operation.planHash.length > 22
                ? `${operation.planHash.slice(0, 22)}…`
                : operation.planHash,
            className: 'mono',
          },
          { text: formatDate(operation.createdAt) },
        ]),
      }),
  };
}

export function renderOperationDetailPage(detail: OperationDetail): UiPageContent {
  const operation = detail.operation;
  const destructiveStatus = operation.destructive
    ? '<span class="state state-retired">オペレーター権限が必要</span>'
    : '<span class="state state-ready">通常</span>';
  const resources = renderTable({
    label: '操作対象リソース',
    columns: [
      { label: 'リソース' },
      { label: '変更前' },
      { label: '変更後' },
      { label: 'リビジョン' },
    ],
    rows: detail.resources.map((resource) => [
      { text: resource.resourceKey, className: 'mono' },
      { html: renderStatus(resource.sourceState) },
      { html: renderStatus(resource.targetState) },
      { text: `r${resource.resourceRevision}`, className: 'mono' },
    ]),
  });
  const steps =
    detail.steps.length === 0
      ? renderEmpty('ステップはありません。')
      : renderTable({
          label: '操作ステップ',
          columns: [
            { label: 'ステップ' },
            { label: '名前' },
            { label: '状態' },
            { label: 'リビジョン' },
          ],
          rows: detail.steps.map((step) => [
            { text: step.position + 1, className: 'mono' },
            { text: step.name },
            { html: renderStatus(step.status) },
            { text: `r${step.revision}`, className: 'mono' },
          ]),
        });
  return {
    title: operation.id,
    body: `${renderPageHeader(operation.id, `${labelValue(operation.kind)} · r${operation.revision}`)}
      <div class="stack">
        ${renderSection(
          '状態',
          '',
          renderDefinitionList([
            { term: '状態', descriptionHtml: renderStatus(operation.status) },
            { term: '破壊的変更', descriptionHtml: destructiveStatus },
            { term: '計画ハッシュ', descriptionText: operation.planHash },
          ]),
        )}
        ${renderSection('リソース', `${detail.resources.length}件`, resources)}
        ${renderSection('ステップ', `${detail.steps.length}件`, steps)}
        ${renderSection(
          '計画',
          '',
          `<pre class="json">${escapeHtml(JSON.stringify(operation.plan, null, 2))}</pre>`,
        )}
      </div>`,
  };
}
