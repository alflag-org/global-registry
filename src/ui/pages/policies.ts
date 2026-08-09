import type { PolicySummary } from '../../application/ports';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import type { UiPageContent } from './types';

export function renderPoliciesPage(policies: readonly PolicySummary[]): UiPageContent {
  return {
    title: 'ポリシー',
    body:
      renderPageHeader('ポリシー', `${policies.length}件`) +
      renderTable({
        label: 'ポリシー一覧',
        columns: [
          { label: '名前空間' },
          { label: 'キー' },
          { label: '状態' },
          { label: '現行バージョン' },
          { label: 'リビジョン' },
        ],
        rows: policies.map((policy) => [
          { text: policy.namespace, className: 'mono' },
          { text: policy.key, className: 'mono' },
          { html: renderStatus(policy.status) },
          { text: `v${policy.version}`, className: 'mono' },
          { text: `r${policy.revision}`, className: 'mono' },
        ]),
      }),
  };
}
