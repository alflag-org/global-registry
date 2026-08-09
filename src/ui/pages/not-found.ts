import { renderPageHeader } from '../components/layout';
import { renderNotice } from '../components/notice';
import type { UiPageContent } from './types';

export function renderNotFoundPage(): UiPageContent {
  return {
    title: 'ページが見つかりません',
    body:
      renderPageHeader('ページが見つかりません') +
      renderNotice('ナビゲーションから表示する項目を選んでください。', { tone: 'error' }),
  };
}
