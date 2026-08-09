import { escapeHtml } from '../format';

export function renderPageHeader(title: unknown, meta?: unknown, actions = ''): string {
  const renderedMeta =
    meta === undefined || meta === null || meta === ''
      ? ''
      : `<div class="page-meta">${escapeHtml(meta)}</div>`;
  return `<header class="page-head"><div><h1>${escapeHtml(title)}</h1>${renderedMeta}</div>${actions}</header>`;
}

export function renderSection(title: unknown, meta: unknown, body: string): string {
  const renderedMeta =
    meta === undefined || meta === null || meta === ''
      ? ''
      : `<div class="section-meta">${escapeHtml(meta)}</div>`;
  return `<section class="section"><div class="section-head"><h2 class="section-title">${escapeHtml(title)}</h2>${renderedMeta}</div>${body}</section>`;
}

export function renderEmpty(message: unknown): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

interface DefinitionItem {
  term: unknown;
  descriptionHtml?: string;
  descriptionText?: unknown;
}

export function renderDefinitionList(items: readonly DefinitionItem[]): string {
  return `<dl class="kv">${items
    .map(
      ({ term, descriptionHtml, descriptionText }) =>
        `<dt>${escapeHtml(term)}</dt><dd>${descriptionHtml ?? escapeHtml(descriptionText)}</dd>`,
    )
    .join('')}</dl>`;
}
