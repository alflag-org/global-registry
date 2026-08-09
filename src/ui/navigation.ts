import type { Actor } from '../domain/models/global-registry';
import { escapeHtml, escapeHtmlAttribute } from './format';

interface NavigationItem {
  path: string;
  label: string;
  adminOnly?: boolean;
}

const navigationItems: readonly NavigationItem[] = [
  { path: '/ui', label: '概要' },
  { path: '/ui/resources', label: 'リソース' },
  { path: '/ui/providers', label: 'プロバイダー' },
  { path: '/ui/operations', label: '操作' },
  { path: '/ui/drifts', label: 'ドリフト' },
  { path: '/ui/profiles', label: 'プロファイル' },
  { path: '/ui/policies', label: 'ポリシー' },
  { path: '/ui/events', label: '監査ログ' },
  { path: '/ui/access', label: 'アクセス管理', adminOnly: true },
  { path: '/docs', label: 'API' },
];

function renderNavigationLink(item: NavigationItem, currentPath: string): string {
  const active =
    currentPath === item.path || (item.path !== '/ui' && currentPath.startsWith(`${item.path}/`));
  return `<a href="${escapeHtmlAttribute(item.path)}" class="nav-link${active ? ' is-active' : ''}"${active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
}

export function renderNavigation(actor: Actor, currentPath: string): string {
  return navigationItems
    .filter((item) => item.adminOnly !== true || actor.role === 'admin')
    .map((item) => renderNavigationLink(item, currentPath))
    .join('');
}
