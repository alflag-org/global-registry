import { escapeHtml } from '../format';

type NoticeTone = 'default' | 'error' | 'warning';

export function renderNotice(message: unknown, options: { tone?: NoticeTone } = {}): string {
  const tone = options.tone ?? 'default';
  return `<div class="notice notice-${tone}">${escapeHtml(message)}</div>`;
}
