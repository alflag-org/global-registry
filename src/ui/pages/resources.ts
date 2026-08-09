import type { Resource } from '../../domain/models/global-registry';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, labelValue, pathSegment } from '../format';
import type { UiPageContent } from './types';

export function renderResourcesPage(
  resources: readonly Resource[],
  nextCursor: string | null = null,
): UiPageContent {
  const nextPage =
    nextCursor === null
      ? ''
      : `<p><a class="button button-secondary" href="/ui/resources?cursor=${pathSegment(nextCursor)}">次のページ</a></p>`;
  return {
    title: 'リソース',
    body:
      renderPageHeader('リソース', `${resources.length}件`) +
      renderTable({
        label: 'リソース一覧',
        columns: [
          { label: 'キー' },
          { label: '種別' },
          { label: 'ライフサイクル' },
          { label: 'リビジョン' },
          { label: '更新日時' },
        ],
        rows: resources.map((resource) => [
          {
            html: `<a class="row-link mono" href="/ui/resources/${pathSegment(resource.key)}">${escapeHtml(resource.key)}</a><div class="status-sub">${escapeHtml(resource.name)}</div>`,
          },
          { text: labelValue(resource.kind) },
          { html: renderStatus(resource.lifecycleState) },
          { text: `r${resource.revision}`, className: 'mono' },
          { text: formatDate(resource.updatedAt) },
        ]),
      }) +
      nextPage,
  };
}
