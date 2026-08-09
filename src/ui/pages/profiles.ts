import type { ProfileSummary } from '../../application/ports';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { labelValue } from '../format';
import type { UiPageContent } from './types';

export function renderProfilesPage(profiles: readonly ProfileSummary[]): UiPageContent {
  return {
    title: 'プロファイル',
    body:
      renderPageHeader('プロファイル', `${profiles.length}件`) +
      renderTable({
        label: 'プロファイル一覧',
        columns: [
          { label: 'キー' },
          { label: 'リソース種別' },
          { label: '状態' },
          { label: '現行バージョン' },
          { label: 'リビジョン' },
        ],
        rows: profiles.map((profile) => [
          { text: profile.key, className: 'mono' },
          { text: labelValue(profile.resourceKind) },
          { html: renderStatus(profile.status) },
          { text: `v${profile.version}`, className: 'mono' },
          { text: `r${profile.revision}`, className: 'mono' },
        ]),
      }),
  };
}
