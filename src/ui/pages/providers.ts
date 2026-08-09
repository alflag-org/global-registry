import type { Provider } from '../../domain/models/global-registry';
import { renderPageHeader } from '../components/layout';
import { renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import type { UiPageContent } from './types';

export function renderProvidersPage(providers: readonly Provider[]): UiPageContent {
  return {
    title: 'プロバイダー',
    body:
      renderPageHeader('プロバイダー', `${providers.length}件`) +
      renderTable({
        label: 'プロバイダー一覧',
        columns: [
          { label: 'プロバイダー' },
          { label: 'ドライバー' },
          { label: '状態' },
          { label: 'リビジョン' },
          { label: '認証情報参照' },
        ],
        rows: providers.map((provider) => [
          { text: provider.id, className: 'mono' },
          { text: provider.driver },
          { html: renderStatus(provider.status) },
          { text: `r${provider.revision}`, className: 'mono' },
          { text: provider.credentialRef, className: 'mono' },
        ]),
      }),
  };
}
