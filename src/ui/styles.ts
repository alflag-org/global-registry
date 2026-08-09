export const styles = `
  :root {
    color-scheme: light;
    --background: #ffffff;
    --sidebar: #f5f6f7;
    --surface-subtle: #f8f9fa;
    --line: #d9dde3;
    --line-soft: #e8eaee;
    --text: #20242a;
    --text-secondary: #3f4752;
    --text-table-head: #4b5563;
    --muted: #5f6875;
    --accent: #1d4ed8;
    --accent-hover: #1e40af;
    --accent-active: #1e3a8a;
    --nav-hover: #e9ebee;
    --nav-active: #e1e5ea;
    --nav-active-text: #18202a;
    --input-line: #8b95a3;
    --success: #166534;
    --warn: #92400e;
    --danger: #b42318;
    --danger-text: #8f1d15;
    --danger-line: #e5aaa6;
    --danger-surface: #fff7f6;
    --focus: #1d4ed8;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--background);
    color: var(--text);
  }
  * { box-sizing: border-box; }
  html { overflow-x: hidden; }
  body { margin: 0; min-width: 320px; background: var(--background); color: var(--text); font-size: 14px; }
  a { color: inherit; }
  button, input, select, textarea { font: inherit; }
  button, input, select, textarea { border-radius: 4px; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex="0"]:focus-visible, summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .skip-link { position: fixed; top: 8px; left: 8px; z-index: 100; transform: translateY(-150%); background: var(--text); color: #fff; padding: 9px 12px; }
  .skip-link:focus { transform: translateY(0); }
  .shell { min-height: 100vh; display: grid; grid-template-columns: 202px minmax(0, 1fr); }
  .rail { position: sticky; top: 0; height: 100vh; min-width: 0; padding: 20px 12px 14px; border-right: 1px solid var(--line); background: var(--sidebar); display: flex; flex-direction: column; gap: 16px; }
  .brand { padding: 0 10px 8px; font-size: 15px; font-weight: 700; }
  .nav { display: grid; gap: 2px; }
  .nav-link { min-height: 36px; display: flex; align-items: center; color: var(--text-secondary); text-decoration: none; padding: 8px 10px; border-radius: 4px; }
  .nav-link:hover { color: var(--text); background: var(--nav-hover); }
  .nav-link.is-active { color: var(--nav-active-text); background: var(--nav-active); font-weight: 650; }
  .rail-footer { margin-top: auto; border-top: 1px solid var(--line); padding: 12px 10px 0; min-width: 0; }
  .actor-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actor-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .workspace { min-width: 0; padding: 34px 40px 64px; max-width: 1320px; width: 100%; }
  .page-head { margin: 0 0 24px; display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  h1 { font-size: 24px; font-weight: 650; letter-spacing: -.015em; line-height: 1.3; margin: 0; overflow-wrap: anywhere; }
  .page-meta { color: var(--muted); font-size: 12px; margin-top: 5px; }
  .page-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); margin: 0 0 34px; border-block: 1px solid var(--line); }
  .summary > div { padding: 13px 16px; border-right: 1px solid var(--line-soft); }
  .summary > div:last-child { border-right: 0; }
  .summary dt { color: var(--muted); font-size: 12px; }
  .summary dd { margin: 4px 0 0; font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .stack { display: grid; gap: 30px; }
  .section { min-width: 0; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 9px; }
  .section-title { font-size: 14px; font-weight: 650; margin: 0; }
  .section-meta { color: var(--muted); font-size: 12px; }
  .table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--line); }
  table { width: 100%; border-collapse: collapse; min-width: 600px; }
  .access-table table { min-width: 1120px; }
  th { color: var(--text-table-head); background: var(--surface-subtle); font-size: 11px; font-weight: 650; text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { color: var(--text-secondary); font-size: 13px; padding: 10px 11px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: #fafbfc; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); overflow-wrap: anywhere; }
  .row-link { display: inline-flex; align-items: center; min-height: 24px; color: var(--accent); text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
  .row-link:hover { text-decoration-color: currentColor; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
  .state-healthy, .state-ready, .state-serving, .state-succeeded, .state-published, .state-active { color: var(--success); }
  .state-degraded, .state-running, .state-planned, .state-acknowledged, .state-configured, .state-allocated { color: var(--warn); }
  .state-unhealthy, .state-failed, .state-retired, .state-critical, .state-inactive, .state-disabled { color: var(--danger); }
  .status-sub { color: var(--muted); font-size: 11px; margin-top: 3px; }
  .empty { color: var(--muted); line-height: 1.5; margin: 0; padding: 14px 0; }
  .notice { border: 1px solid var(--line); background: var(--surface-subtle); padding: 11px 12px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
  .notice-error { border-color: var(--danger-line); color: var(--danger-text); background: var(--danger-surface); }
  .notice-warning { border-color: #d6ad6b; color: #713f12; background: #fffbeb; }
  .kv { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 0 16px; margin: 0; }
  .kv dt { color: var(--muted); font-size: 12px; padding: 9px 0; border-bottom: 1px solid var(--line-soft); }
  .kv dd { margin: 0; color: var(--text); padding: 9px 0; border-bottom: 1px solid var(--line-soft); overflow-wrap: anywhere; }
  .form-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; max-width: 720px; }
  .filter-form { display: grid; gap: 14px; margin-bottom: 24px; padding: 16px; border: 1px solid var(--line); background: var(--surface-subtle); }
  .filter-grid { display: grid; grid-template-columns: minmax(180px, 2fr) repeat(3, minmax(140px, 1fr)); gap: 12px; align-items: end; }
  label { color: var(--text-secondary); font-size: 12px; font-weight: 600; margin-top: 7px; }
  input, select, textarea { min-height: 38px; width: 100%; color: var(--text); background: var(--background); border: 1px solid var(--input-line); padding: 8px 9px; }
  input[type="checkbox"] { width: 20px; min-height: 20px; margin: 0; }
  .checkbox-field { display: flex; align-items: center; gap: 9px; margin-top: 9px; }
  .checkbox-field label { margin: 0; }
  .form-help { color: var(--muted); font-size: 12px; line-height: 1.45; margin-bottom: 5px; }
  .button { min-height: 38px; width: auto; appearance: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; justify-self: start; background: var(--accent); color: #ffffff; border: 1px solid var(--accent); padding: 8px 12px; text-decoration: none; font-size: 13px; font-weight: 650; }
  .button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .button:active { background: var(--accent-active); border-color: var(--accent-active); }
  .button-secondary { background: var(--background); color: var(--text); border-color: var(--input-line); }
  .button-secondary:hover { background: var(--surface-subtle); border-color: var(--text-secondary); }
  .button:disabled { cursor: not-allowed; opacity: .55; }
  .form-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
  .form-status { min-height: 22px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .form-status.is-error { color: var(--danger-text); }
  .form-status.is-success { color: var(--success); }
  .json { background: var(--surface-subtle); border: 1px solid var(--line); color: var(--text-secondary); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: 360px; overflow: auto; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .identity-card { max-width: 720px; border: 1px solid var(--line); padding: 18px; display: grid; gap: 14px; }
  .identity-value { display: block; padding: 11px; background: var(--surface-subtle); border: 1px solid var(--line-soft); overflow-wrap: anywhere; }
  .standalone { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
  .standalone-main { width: min(100%, 680px); }
  .standalone-main h1 { margin-bottom: 12px; }
  .standalone-main > p { color: var(--text-secondary); line-height: 1.65; margin: 0 0 22px; }
  @media (max-width: 980px) {
    .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 800px) {
    .summary { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    .summary > div:nth-child(2) { border-right: 0; }
    .summary > div:nth-child(-n+2) { border-bottom: 1px solid var(--line-soft); }
  }
  @media (max-width: 680px) {
    .shell { display: block; }
    .rail { position: static; height: auto; padding: 11px 12px; border-right: 0; border-bottom: 1px solid var(--line); gap: 8px; }
    .brand { padding: 0 5px; }
    .nav { display: flex; gap: 2px; overflow-x: auto; padding-bottom: 3px; }
    .nav-link { min-height: 44px; flex: 0 0 auto; }
    .rail-footer { margin-top: 2px; padding: 8px 5px 0; display: flex; gap: 7px; flex-wrap: wrap; }
    .actor-meta { margin-top: 0; }
    .workspace { padding: 24px 16px 48px; }
    .page-head { display: grid; }
    .page-meta, .section-meta, .summary dt, th, td, .state, label, .status-sub, .form-help { font-size: 14px; }
    .row-link, input, select, textarea, .button { min-height: 44px; }
    .kv { grid-template-columns: 1fr; gap: 0; }
    .kv dt { border-bottom: 0; padding-bottom: 2px; }
    .kv dd { padding-top: 2px; }
    .filter-grid { grid-template-columns: 1fr; }
    .filter-form .button { width: 100%; }
    .form-actions { align-items: stretch; }
    .form-actions .button { width: 100%; }
  }
`;
