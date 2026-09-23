export const client = String.raw`
'use strict';
const main = document.getElementById('main');
const storedLang = localStorage.getItem('registry-lang');
const LANG =
  storedLang || ((navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en');
document.documentElement.lang = LANG;
const entityNames = {
  en: {
    locations: 'Locations',
    devices: 'Devices',
    'virtual-machines': 'Virtual Machines',
    interfaces: 'Interfaces',
    vlans: 'VLANs',
    prefixes: 'Prefixes',
    'ip-addresses': 'IP Addresses',
    'audit-log': 'Audit Log',
  },
  ja: {
    locations: 'ロケーション',
    devices: 'デバイス',
    'virtual-machines': '仮想マシン',
    interfaces: 'インターフェース',
    vlans: 'VLAN',
    prefixes: 'プレフィックス',
    'ip-addresses': 'IPアドレス',
    'audit-log': '監査ログ',
  },
};
const singular = {
  en: {
    locations: 'Location',
    devices: 'Device',
    'virtual-machines': 'Virtual Machine',
    interfaces: 'Interface',
    vlans: 'VLAN',
    prefixes: 'Prefix',
    'ip-addresses': 'IP Address',
  },
  ja: {
    locations: 'ロケーション',
    devices: 'デバイス',
    'virtual-machines': '仮想マシン',
    interfaces: 'インターフェース',
    vlans: 'VLAN',
    prefixes: 'プレフィックス',
    'ip-addresses': 'IPアドレス',
  },
};
const fieldNames = {
  en: {
    name: 'Name',
    slug: 'Slug',
    description: 'Description',
    role: 'Role',
    location_id: 'Location',
    host_device_id: 'Host device',
    device_id: 'Device',
    virtual_machine_id: 'Virtual machine',
    vlan_id: 'VLAN',
    prefix_id: 'Prefix',
    interface_id: 'Interface',
    address: 'Address',
    status: 'Status',
    dns_name: 'DNS name',
    mac_address: 'MAC address',
    vid: 'VLAN ID',
    cidr: 'CIDR',
    vcpu: 'vCPU',
    memory_mb: 'Memory (MB)',
    disk_mb: 'Disk (MB)',
    source: 'Source',
    source_scope: 'Source scope',
    source_id: 'Source ID',
    serial_number: 'Serial number',
    manufacturer: 'Manufacturer',
    model: 'Model',
    actor: 'Actor',
    action: 'Action',
    entity_type: 'Entity type',
    entity_id: 'Entity ID',
    created_at: 'Created at',
    updated_at: 'Updated at',
    before_json: 'Before JSON',
    after_json: 'After JSON',
    q: 'Keyword',
    location: 'Location',
    host_device: 'Host device',
    vlan: 'VLAN',
    interfaces: 'Interfaces',
    ip_addresses: 'IP addresses',
    virtual_machines: 'Virtual machines',
    more_specific_prefixes: 'More specific prefixes',
  },
  ja: {
    name: '名前',
    slug: 'スラッグ',
    description: '説明',
    role: 'ロール',
    location_id: 'ロケーション',
    host_device_id: 'ホストデバイス',
    device_id: 'デバイス',
    virtual_machine_id: '仮想マシン',
    vlan_id: 'VLAN',
    prefix_id: 'プレフィックス',
    interface_id: 'インターフェース',
    address: 'アドレス',
    status: 'ステータス',
    dns_name: 'DNS名',
    mac_address: 'MACアドレス',
    vid: 'VLAN ID',
    cidr: 'CIDR',
    vcpu: 'vCPU',
    memory_mb: 'メモリ (MB)',
    disk_mb: 'ディスク (MB)',
    source: 'ソース',
    source_scope: 'ソーススコープ',
    source_id: 'ソースID',
    serial_number: 'シリアル番号',
    manufacturer: 'メーカー',
    model: 'モデル',
    actor: 'アクター',
    action: 'アクション',
    entity_type: 'エンティティ種別',
    entity_id: 'エンティティID',
    created_at: '作成日時',
    updated_at: '更新日時',
    before_json: '変更前',
    after_json: '変更後',
    q: 'キーワード',
    location: 'ロケーション',
    host_device: 'ホストデバイス',
    vlan: 'VLAN',
    interfaces: 'インターフェース',
    ip_addresses: 'IPアドレス',
    virtual_machines: '仮想マシン',
    more_specific_prefixes: '下位プレフィックス',
  },
};
const valueLabels = {
  en: {
    assigned: 'assigned',
    reserved: 'reserved',
    create: 'create',
    update: 'update',
    delete: 'delete',
    allocate: 'allocate',
    release: 'release',
  },
  ja: {
    assigned: '割当済み',
    reserved: '予約済み',
    create: '作成',
    update: '更新',
    delete: '削除',
    allocate: '割り当て',
    release: '解放',
  },
};
const messages = {
  en: {
    loading: 'Loading inventory…',
    search: 'Search',
    searchPlaceholder: 'Search name, description…',
    records: (n) => n + ' records',
    previous: 'Previous',
    next: 'Next',
    noRecords: 'No records.',
    create: (s) => 'Create ' + s,
    createRecord: 'Create record',
    save: 'Save changes',
    cancel: 'Cancel',
    edit: 'Edit',
    del: 'Delete',
    release: 'Release IP address',
    allocate: 'Allocate IP address',
    addInterface: 'Add interface',
    registerIp: 'Register IP address',
    backTo: (n) => 'Back to ' + n,
    choose: 'Choose…',
    none: '— None —',
    confirmDelete:
      'Delete this record? Dependent allocations are retained; required relationships may prevent deletion.',
    authRequired:
      'Authentication required. Production users must sign in through Cloudflare Access.',
    requestFailed: 'Request failed.',
    notFound: 'Page not found.',
    homeTitle: 'Infrastructure inventory',
    language: 'Language',
    sectionInfrastructure: 'Infrastructure',
    sectionNetwork: 'Network',
    sectionActivity: 'Activity',
    apiDocs: 'API documentation',
    authTitle: 'Local development access',
    authHelp:
      'Enter LOCAL_AUTH_SECRET from your local .dev.vars file. It is kept in this browser tab only.',
    authSecret: 'Local secret',
    authContinue: 'Continue',
  },
  ja: {
    loading: '読み込み中…',
    search: '検索',
    searchPlaceholder: '名前・説明などで検索',
    records: (n) => n + ' 件',
    previous: '前へ',
    next: '次へ',
    noRecords: 'レコードがありません。',
    create: (s) => s + ' を作成',
    createRecord: '作成',
    save: '変更を保存',
    cancel: 'キャンセル',
    edit: '編集',
    del: '削除',
    release: 'IPアドレスを解放',
    allocate: 'IPアドレスを割り当て',
    addInterface: 'インターフェースを追加',
    registerIp: 'IPアドレスを登録',
    backTo: (n) => n + ' に戻る',
    choose: '選択してください',
    none: '— なし —',
    confirmDelete:
      'このレコードを削除しますか？依存する割り当ては保持されますが、必須の関連付けがある場合は削除できません。',
    authRequired: '認証が必要です。本番環境では Cloudflare Access 経由でサインインしてください。',
    requestFailed: 'リクエストに失敗しました。',
    notFound: 'ページが見つかりません。',
    homeTitle: 'ダッシュボード',
    language: '言語',
    sectionInfrastructure: 'インフラ',
    sectionNetwork: 'ネットワーク',
    sectionActivity: 'アクティビティ',
    apiDocs: 'API ドキュメント',
    authTitle: 'ローカル開発アクセス',
    authHelp:
      '.dev.vars の LOCAL_AUTH_SECRET を入力してください。このブラウザタブ内でのみ保持されます。',
    authSecret: 'ローカルシークレット',
    authContinue: '続行',
  },
};
const t = (key, ...args) => {
  const v = (messages[LANG] && messages[LANG][key]) ?? messages.en[key];
  return typeof v === 'function' ? v(...args) : v;
};
const names = entityNames[LANG] || entityNames.en;
const one = singular[LANG] || singular.en;
const title = (k) =>
  (fieldNames[LANG] && fieldNames[LANG][k]) ??
  fieldNames.en[k] ??
  k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const valueLabel = (v) => (valueLabels[LANG] && valueLabels[LANG][v]) ?? v;
for (const e of document.querySelectorAll('[data-i18n]')) {
  const v = names[e.dataset.i18n] ?? t(e.dataset.i18n);
  if (v) e.textContent = v;
}
const langSelect = document.getElementById('lang');
langSelect.value = storedLang && messages[storedLang] ? storedLang : LANG;
langSelect.addEventListener('change', () => {
  localStorage.setItem('registry-lang', langSelect.value);
  location.reload();
});
const refs = {
  location_id: 'locations',
  host_device_id: 'devices',
  device_id: 'devices',
  virtual_machine_id: 'virtual-machines',
  vlan_id: 'vlans',
  prefix_id: 'prefixes',
  interface_id: 'interfaces',
};
// Filter parameters that become dropdowns instead of free-text inputs.
const filterChoices = {
  entity_type: ['devices', 'interfaces', 'ip_addresses', 'locations', 'prefixes', 'virtual_machines', 'vlans'],
  action: ['allocate', 'create', 'delete', 'release', 'update'],
};
// Editor fields that offer suggestions from existing records while staying free-text.
const sourceKeys = ['source', 'source_scope', 'source_id'];
let spec;
const el = (tag, text, attrs = {}) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const link = (text, href, cls) => el('a', text, { href, ...(cls ? { class: cls } : {}) });
const errorBox = (error) => {
  let box = document.getElementById('error');
  if (!box) {
    box = el('p', '', { class: 'error', role: 'alert', id: 'error' });
    main.prepend(box);
  }
  box.textContent = error.message || String(error);
};
async function request(path, options = {}) {
  const secret = sessionStorage.getItem('registry-local-secret');
  const headers = {
    Accept: 'application/json',
    ...(secret ? { 'x-global-registry-dev-secret': secret } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) {
    const err = new Error(t('authRequired'));
    if (
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]'
    )
      document.getElementById('auth').showModal();
    throw err;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: t('requestFailed') }));
    throw new Error(data.message);
  }
  return response.status === 204 ? null : response.json();
}
document.getElementById('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  sessionStorage.setItem('registry-local-secret', new FormData(event.target).get('secret'));
  try {
    spec = await request('/openapi.json');
    document.getElementById('auth').close();
    await render();
  } catch (error) {
    document.getElementById('auth-error').textContent = error.message;
  }
});
function resolve(schema) {
  return schema && schema.$ref
    ? resolve(
        schema.$ref
          .split('/')
          .slice(1)
          .reduce((v, k) => v[k], spec),
      )
    : schema;
}
function primitive(schema) {
  schema = resolve(schema);
  if (schema.anyOf) return primitive(schema.anyOf.find((x) => x.type !== 'null'));
  return {
    ...schema,
    type: Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type,
  };
}
const display = (row) => row.name || row.cidr || row.address || row.slug || row.id;
function valueNode(key, value) {
  if (value == null) return el('span', '—', { class: 'muted' });
  if (refs[key]) return link(String(value), '/' + refs[key] + '/' + value);
  if (key === 'action' || key === 'status') return el('span', valueLabel(value));
  if (key.endsWith('_json')) {
    try {
      return el('pre', JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      return el('pre', value);
    }
  }
  return el('span', String(value));
}
function table(path, rows) {
  if (!rows.length) return el('p', t('noRecords'), { class: 'muted' });
  const preferred = {
    locations: ['name', 'slug', 'description'],
    devices: ['name', 'role', 'location_id', 'source'],
    'virtual-machines': ['name', 'host_device_id', 'vcpu', 'memory_mb', 'source'],
    interfaces: ['name', 'device_id', 'virtual_machine_id', 'mac_address'],
    vlans: ['vid', 'name', 'location_id'],
    prefixes: ['cidr', 'name', 'location_id', 'vlan_id'],
    'ip-addresses': ['address', 'status', 'prefix_id', 'interface_id', 'dns_name'],
    'audit-log': ['created_at', 'actor', 'action', 'entity_type', 'entity_id'],
  };
  const columns = preferred[path];
  const t2 = el('table');
  const head = el('tr');
  for (const col of columns) head.append(el('th', title(col)));
  t2.append(el('thead'));
  t2.firstChild.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    columns.forEach((col, index) => {
      const td = el('td');
      td.append(
        index === 0
          ? link(String(row[col] ?? '—'), '/' + path + '/' + row.id)
          : valueNode(col, row[col]),
      );
      tr.append(td);
    });
    body.append(tr);
  }
  t2.append(body);
  const wrapper = el('div', undefined, { class: 'table-wrap' });
  wrapper.append(t2);
  return wrapper;
}
async function optionsFor(path) {
  let items = [],
    offset = 0;
  for (;;) {
    const result = await request('/api/v1/' + path + '?limit=200&offset=' + offset);
    items.push(...result.items);
    offset += result.items.length;
    if (offset >= result.total || !result.items.length) break;
  }
  return items;
}
let sourceRows;
async function sourceSuggestions(key) {
  if (!sourceRows) {
    sourceRows = [];
    for (const path of ['devices', 'virtual-machines']) sourceRows.push(...(await optionsFor(path)));
  }
  return [...new Set(sourceRows.map((row) => row[key]).filter(Boolean))].sort();
}
function choiceLabel(key, value) {
  if (key === 'entity_type') return names[value.replace(/_/g, '-')] || value;
  return valueLabel(value);
}
async function field(key, schema, value, required) {
  const base = primitive(schema);
  let input;
  if (refs[key]) {
    input = el('select');
    if (!required) input.append(el('option', t('none'), { value: '' }));
    else input.append(el('option', t('choose'), { value: '' }));
    for (const row of await optionsFor(refs[key]))
      input.append(el('option', display(row) + ' · ' + row.id.slice(0, 8), { value: row.id }));
  } else if (base.enum || filterChoices[key]) {
    input = el('select');
    if (!required) input.append(el('option', t('none'), { value: '' }));
    for (const v of base.enum || filterChoices[key])
      input.append(el('option', base.enum ? v : choiceLabel(key, v), { value: v }));
  } else if (key === 'description') input = el('textarea');
  else if (sourceKeys.includes(key)) {
    input = el('input', undefined, { type: 'text', list: 'dl-' + key });
    const dl = el('datalist', undefined, { id: 'dl-' + key });
    for (const v of await sourceSuggestions(key)) dl.append(el('option', undefined, { value: v }));
    const label2 = el('label', title(key) + (required ? ' *' : ''));
    input.name = key;
    input.required = required;
    if (base.maxLength) input.maxLength = base.maxLength;
    if (value != null) input.value = value;
    label2.append(input, dl);
    return { label: label2, input, base };
  } else {
    input = el('input', undefined, {
      type: base.type === 'integer' || base.type === 'number' ? 'number' : 'text',
    });
  }
  input.name = key;
  input.required = required;
  if (key === 'q') input.placeholder = t('searchPlaceholder');
  if (base.minimum !== undefined) input.min = base.minimum;
  if (base.maximum !== undefined) input.max = base.maximum;
  if (base.maxLength) input.maxLength = base.maxLength;
  if (base.type === 'integer') {
    input.step = '1';
    if (base.exclusiveMinimum !== undefined) input.min = base.exclusiveMinimum + 1;
  }
  if (value != null) input.value = value;
  const label = el('label', title(key) + (required ? ' *' : ''));
  label.append(input);
  return { label, input, base };
}
async function editor(path, existing, allocation = false) {
  const endpoint = '/api/v1/' + path + (allocation ? '/{id}/allocate' : '');
  const schema = resolve(spec.paths[endpoint].post.requestBody.content['application/json'].schema);
  const form = el('form', undefined, { class: 'editor' });
  const inputs = [];
  const preset = Object.fromEntries(new URLSearchParams(location.search));
  for (const [key, definition] of Object.entries(schema.properties)) {
    const f = await field(
      key,
      definition,
      existing ? existing[key] : preset[key],
      (schema.required || []).includes(key),
    );
    form.append(f.label);
    inputs.push({ key, ...f });
  }
  const buttons = el('div', undefined, { class: 'actions' });
  const submit = el(
    'button',
    allocation ? t('allocate') : existing ? t('save') : t('createRecord'),
    { type: 'submit' },
  );
  buttons.append(
    submit,
    link(t('cancel'), '/' + path + (existing ? '/' + existing.id : ''), 'button secondary'),
  );
  form.append(buttons);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const body = {};
      for (const f of inputs) {
        const value = f.input.value;
        body[f.key] =
          value === ''
            ? null
            : f.base.type === 'integer' || f.base.type === 'number'
              ? Number(value)
              : value;
      }
      const url =
        '/api/v1/' +
        path +
        (allocation ? '/' + existing.id + '/allocate' : existing ? '/' + existing.id : '');
      const row = await request(url, {
        method: allocation || !existing ? 'POST' : 'PATCH',
        body: JSON.stringify(body),
      });
      location.href = '/' + (allocation ? 'ip-addresses' : path) + '/' + row.id;
    } catch (error) {
      errorBox(error);
      submit.disabled = false;
    }
  });
  main.append(form);
}
async function listPage(path) {
  const params = new URLSearchParams(location.search);
  const filters = el('form', undefined, { class: 'filters' });
  const route = spec.paths['/api/v1/' + path].get;
  for (const parameter of route.parameters || []) {
    if (parameter.in !== 'query' || ['limit', 'offset'].includes(parameter.name)) continue;
    const f = await field(parameter.name, parameter.schema, params.get(parameter.name), false);
    filters.append(f.label);
  }
  filters.append(el('button', t('search'), { type: 'submit' }));
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(filters)) if (v) next.set(k, v);
    location.search = next.toString();
  });
  const toolbar = el('div', undefined, { class: 'toolbar' });
  toolbar.append(filters);
  if (path !== 'audit-log')
    toolbar.append(link(t('create', one[path]), '/' + path + '/new', 'button'));
  main.append(toolbar);
  const result = await request('/api/v1/' + path + '?' + params.toString());
  main.append(el('p', t('records', result.total), { class: 'muted' }), table(path, result.items));
  const offset = Number(params.get('offset') || 0),
    limit = Number(params.get('limit') || 50);
  const pager = el('div', undefined, { class: 'actions' });
  if (offset > 0) {
    const prev = new URLSearchParams(params);
    prev.set('offset', Math.max(0, offset - limit));
    pager.append(link(t('previous'), '?' + prev.toString(), 'button secondary'));
  }
  if (offset + result.items.length < result.total) {
    const next = new URLSearchParams(params);
    next.set('offset', offset + limit);
    pager.append(link(t('next'), '?' + next.toString(), 'button secondary'));
  }
  main.append(pager);
}
async function detailPage(path, id) {
  const row = await request('/api/v1/' + path + '/' + id);
  main.querySelector('h1').textContent = display(row);
  if (new URLSearchParams(location.search).has('edit') && path !== 'audit-log')
    return editor(path, row);
  if (new URLSearchParams(location.search).has('allocate') && path === 'prefixes')
    return editor(path, row, true);
  const actions = el('div', undefined, { class: 'actions' });
  actions.append(link(t('backTo', names[path]), '/' + path, 'button secondary'));
  if (path !== 'audit-log') {
    actions.append(link(t('edit'), '?edit', 'button'));
    const remove = el('button', path === 'ip-addresses' ? t('release') : t('del'), {
      class: 'danger',
      type: 'button',
    });
    remove.addEventListener('click', async () => {
      if (!confirm(t('confirmDelete'))) return;
      remove.disabled = true;
      try {
        await request('/api/v1/' + path + '/' + id, { method: 'DELETE' });
        location.href = '/' + path;
      } catch (error) {
        errorBox(error);
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }
  if (path === 'prefixes') actions.append(link(t('allocate'), '?allocate', 'button'));
  if (path === 'devices' || path === 'virtual-machines')
    actions.append(
      link(
        t('addInterface'),
        '/interfaces/new?' + (path === 'devices' ? 'device_id' : 'virtual_machine_id') + '=' + id,
        'button',
      ),
    );
  if (path === 'interfaces')
    actions.append(link(t('registerIp'), '/ip-addresses/new?interface_id=' + id, 'button'));
  main.append(actions);
  const dl = el('dl');
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object') continue;
    dl.append(el('dt', title(key)), el('dd'));
    dl.lastChild.append(valueNode(key, value));
  }
  main.append(dl);
  for (const [key, target] of [
    ['location', 'locations'],
    ['host_device', 'devices'],
    ['vlan', 'vlans'],
  ])
    if (row[key]) {
      main.append(el('h2', title(key)), link(display(row[key]), '/' + target + '/' + row[key].id));
    }
  for (const [key, target] of [
    ['interfaces', 'interfaces'],
    ['ip_addresses', 'ip-addresses'],
    ['virtual_machines', 'virtual-machines'],
    ['more_specific_prefixes', 'prefixes'],
  ])
    if (row[key]) {
      main.append(el('h2', title(key)), table(target, row[key]));
    }
}
async function render() {
  if (!spec) spec = await request('/openapi.json');
  main.replaceChildren();
  const [path, id] = location.pathname.split('/').filter(Boolean);
  for (const a of document.querySelectorAll('nav a'))
    if (a.getAttribute('href') === '/' + path) a.setAttribute('aria-current', 'page');
  if (!path) {
    main.append(el('h1', t('homeTitle')));
    const cards = el('div', undefined, { class: 'cards' });
    main.append(cards);
    for (const p of ['locations', 'devices', 'virtual-machines', 'prefixes', 'ip-addresses']) {
      const result = await request('/api/v1/' + p + '?limit=1');
      const card = el('div', undefined, { class: 'card' });
      card.append(link(names[p], '/' + p), el('strong', String(result.total)));
      cards.append(card);
    }
    return;
  }
  if (!names[path]) throw new Error(t('notFound'));
  main.append(el('h1', names[path]));
  if (id === 'new' && path !== 'audit-log') await editor(path);
  else if (id) await detailPage(path, id);
  else await listPage(path);
}
render().catch(errorBox);
`;
