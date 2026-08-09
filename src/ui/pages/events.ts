import type { AuditEvent } from '../../domain/models/global-registry';
import { renderPageHeader } from '../components/layout';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, labelValue } from '../format';
import type { UiPageContent } from './types';

export function renderEventsPage(events: readonly AuditEvent[]): UiPageContent {
  return {
    title: '監査ログ',
    body:
      renderPageHeader('監査ログ', `${events.length}件表示`) +
      renderTable({
        label: '監査ログ一覧',
        columns: [
          { label: '発生日時' },
          { label: '種別' },
          { label: 'リソース' },
          { label: '操作' },
          { label: '実行者' },
        ],
        rows: events.map((event) => [
          { text: formatDate(event.occurredAt) },
          {
            html: `${escapeHtml(labelValue(event.eventType))}<div class="status-sub mono">${escapeHtml(event.eventType)}</div>`,
          },
          { text: event.resourceKey, className: 'mono' },
          { text: event.operationId, className: 'mono' },
          { text: event.actorId, className: 'mono' },
        ]),
      }),
  };
}
