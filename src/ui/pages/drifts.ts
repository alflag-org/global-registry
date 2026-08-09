import type { Drift } from '../../domain/models/global-registry';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { formatDate } from '../format';
import type { UiPageContent } from './types';

export function renderDriftsPage(drifts: readonly Drift[]): UiPageContent {
  return {
    title: 'ドリフト',
    body:
      renderPageHeader('ドリフト', `${drifts.length}件`) +
      renderTable({
        label: 'ドリフト一覧',
        columns: [
          { label: 'ドリフト' },
          { label: '重要度' },
          { label: '状態' },
          { label: 'リビジョン' },
          { label: '更新日時' },
        ],
        rows: drifts.map((drift) => [
          { text: drift.id, className: 'mono' },
          { html: renderStatus(drift.severity) },
          { html: renderStatus(drift.status) },
          { text: `r${drift.revision}`, className: 'mono' },
          { text: formatDate(drift.updatedAt) },
        ]),
      }),
  };
}
