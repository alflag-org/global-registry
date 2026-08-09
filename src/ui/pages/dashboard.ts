import type { Drift, Operation, Provider, Resource } from '../../domain/models/global-registry';
import { renderPageHeader, renderSection } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, labelValue, pathSegment } from '../format';
import type { UiPageContent } from './types';

export function renderDashboardPage(input: {
  resources: readonly Resource[];
  operations: readonly Operation[];
  drifts: readonly Drift[];
  providers: readonly Provider[];
}): UiPageContent {
  const activeOperations = input.operations.filter(
    (operation) => operation.status === 'running' || operation.status === 'blocked',
  ).length;
  const openDrifts = input.drifts.filter((drift) => drift.status === 'open');
  const resourceTable = renderTable({
    label: '最近のリソース',
    columns: [
      { label: 'キー' },
      { label: '種別' },
      { label: 'ライフサイクル' },
      { label: 'リビジョン' },
    ],
    rows: input.resources.slice(0, 10).map((resource) => [
      {
        html: `<a class="row-link mono" href="/ui/resources/${pathSegment(resource.key)}">${escapeHtml(resource.key)}</a>`,
      },
      { text: labelValue(resource.kind) },
      { html: renderStatus(resource.lifecycleState) },
      { text: `r${resource.revision}`, className: 'mono' },
    ]),
  });
  const driftTable = renderTable({
    label: '未解決のドリフト',
    columns: [{ label: 'ドリフト' }, { label: '重要度' }, { label: '状態' }, { label: '更新日時' }],
    rows: openDrifts
      .slice(0, 10)
      .map((drift) => [
        { text: drift.id, className: 'mono' },
        { html: renderStatus(drift.severity) },
        { html: renderStatus(drift.status) },
        { text: formatDate(drift.updatedAt) },
      ]),
    emptyMessage: '未解決のドリフトはありません。',
  });
  return {
    title: '概要',
    body: `${renderPageHeader('概要')}
      <dl class="summary">
        <div><dt>リソース</dt><dd>${input.resources.length}</dd></div>
        <div><dt>プロバイダー</dt><dd>${input.providers.length}</dd></div>
        <div><dt>実行中の操作</dt><dd>${activeOperations}</dd></div>
        <div><dt>未解決のドリフト</dt><dd>${openDrifts.length}</dd></div>
      </dl>
      <div class="stack">
        ${renderSection('リソース', `${input.resources.length}件`, resourceTable)}
        ${renderSection('ドリフト', `${openDrifts.length}件未解決`, driftTable)}
      </div>`,
  };
}
