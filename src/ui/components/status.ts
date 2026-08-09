import { escapeHtml, labelValue } from '../format';

export function renderStatus(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const className = text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `<span class="state state-${className}">${escapeHtml(labelValue(value))}</span>`;
}
