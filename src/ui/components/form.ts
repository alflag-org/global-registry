import { escapeHtml, escapeHtmlAttribute } from '../format';

interface InputOptions {
  id: string;
  name: string;
  label: string;
  value?: unknown;
  type?: 'text' | 'search';
  required?: boolean;
  maxLength?: number;
  description?: string;
  placeholder?: string;
  autocomplete?: string;
  pattern?: string;
  title?: string;
}

function describedBy(options: { id: string; description?: string }): string {
  return options.description === undefined
    ? ''
    : ` aria-describedby="${escapeHtmlAttribute(`${options.id}-help`)}"`;
}

function renderDescription(id: string, description: string | undefined): string {
  return description === undefined
    ? ''
    : `<span class="form-help" id="${escapeHtmlAttribute(`${id}-help`)}">${escapeHtml(description)}</span>`;
}

export function renderInput(options: InputOptions): string {
  const value = options.value === undefined ? '' : ` value="${escapeHtmlAttribute(options.value)}"`;
  const required = options.required === true ? ' required' : '';
  const maxLength =
    options.maxLength === undefined ? '' : ` maxlength="${options.maxLength.toString()}"`;
  const placeholder =
    options.placeholder === undefined
      ? ''
      : ` placeholder="${escapeHtmlAttribute(options.placeholder)}"`;
  const autocomplete =
    options.autocomplete === undefined
      ? ''
      : ` autocomplete="${escapeHtmlAttribute(options.autocomplete)}"`;
  const pattern =
    options.pattern === undefined ? '' : ` pattern="${escapeHtmlAttribute(options.pattern)}"`;
  const title = options.title === undefined ? '' : ` title="${escapeHtmlAttribute(options.title)}"`;
  return `<label for="${escapeHtmlAttribute(options.id)}">${escapeHtml(options.label)}</label><input id="${escapeHtmlAttribute(options.id)}" name="${escapeHtmlAttribute(options.name)}" type="${options.type ?? 'text'}"${value}${required}${maxLength}${placeholder}${autocomplete}${pattern}${title}${describedBy(options)} />${renderDescription(options.id, options.description)}`;
}

interface SelectOption {
  value: string;
  label: string;
}

export function renderSelect(options: {
  id: string;
  name: string;
  label: string;
  options: readonly SelectOption[];
  selected?: string;
  description?: string;
  required?: boolean;
}): string {
  const required = options.required === true ? ' required' : '';
  const choices = options.options
    .map(
      (choice) =>
        `<option value="${escapeHtmlAttribute(choice.value)}"${choice.value === options.selected ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`,
    )
    .join('');
  return `<label for="${escapeHtmlAttribute(options.id)}">${escapeHtml(options.label)}</label><select id="${escapeHtmlAttribute(options.id)}" name="${escapeHtmlAttribute(options.name)}"${required}${describedBy(options)}>${choices}</select>${renderDescription(options.id, options.description)}`;
}

export function renderCheckbox(options: {
  id: string;
  name: string;
  label: string;
  checked: boolean;
  description?: string;
}): string {
  return `<div class="checkbox-field"><input id="${escapeHtmlAttribute(options.id)}" name="${escapeHtmlAttribute(options.name)}" type="checkbox" value="true"${options.checked ? ' checked' : ''}${describedBy(options)} /><label for="${escapeHtmlAttribute(options.id)}">${escapeHtml(options.label)}</label></div>${renderDescription(options.id, options.description)}`;
}

export function renderFormStatus(id = 'form-status'): string {
  return `<div class="form-status" id="${escapeHtmlAttribute(id)}" role="status" aria-live="polite"></div>`;
}
