import { escapeHtml, escapeHtmlAttribute } from '../format';
import { renderEmpty } from './layout';

interface TableColumn {
  label: string;
}

type TableCell = { text: unknown; className?: string } | { html: string; className?: string };

interface TableOptions {
  label: string;
  columns: readonly TableColumn[];
  rows: readonly (readonly TableCell[])[];
  emptyMessage?: string;
}

export function renderTable(options: TableOptions): string {
  const heading = options.columns
    .map(({ label }) => `<th scope="col">${escapeHtml(label)}</th>`)
    .join('');
  const rows =
    options.rows.length === 0
      ? `<tr><td colspan="${options.columns.length}">${renderEmpty(options.emptyMessage ?? '表示できるデータがありません。')}</td></tr>`
      : options.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => {
                  const classAttribute =
                    cell.className === undefined
                      ? ''
                      : ` class="${escapeHtmlAttribute(cell.className)}"`;
                  const content = 'html' in cell ? cell.html : escapeHtml(cell.text);
                  return `<td${classAttribute}>${content}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('');
  return `<div class="table-wrap" role="region" aria-label="${escapeHtmlAttribute(options.label)}" tabindex="0"><table><thead><tr>${heading}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
