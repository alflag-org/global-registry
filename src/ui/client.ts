export const client = String.raw`
'use strict';
const main = document.getElementById('main');
const names = {
  locations: 'Locations',
  devices: 'Devices',
  'virtual-machines': 'Virtual Machines',
  interfaces: 'Interfaces',
  vlans: 'VLANs',
  prefixes: 'Prefixes',
  'ip-addresses': 'IP Addresses',
  'audit-log': 'Audit Log',
};
const refs = {
  location_id: 'locations',
  host_device_id: 'devices',
  device_id: 'devices',
  virtual_machine_id: 'virtual-machines',
  vlan_id: 'vlans',
  prefix_id: 'prefixes',
  interface_id: 'interfaces',
};
const labels = {
  vcpu: 'vCPU',
  memory_mb: 'Memory (MB)',
  disk_mb: 'Disk (MB)',
  vid: 'VLAN ID',
  cidr: 'CIDR',
  dns_name: 'DNS name',
  mac_address: 'MAC address',
};
const title = (k) => labels[k] || k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
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
    const err = new Error(
      'Authentication required. Production users must sign in through Cloudflare Access.',
    );
    if (
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]'
    )
      document.getElementById('auth').showModal();
    throw err;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: 'Request failed.' }));
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
  if (!rows.length) return el('p', 'No records.', { class: 'muted' });
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
  const t = el('table');
  const head = el('tr');
  for (const col of columns) head.append(el('th', title(col)));
  t.append(el('thead'));
  t.firstChild.append(head);
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
  t.append(body);
  const wrapper = el('div', undefined, { class: 'table-wrap' });
  wrapper.append(t);
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
async function field(key, schema, value, required) {
  const base = primitive(schema);
  let input;
  if (refs[key]) {
    input = el('select');
    if (!required) input.append(el('option', '— None —', { value: '' }));
    else input.append(el('option', 'Choose…', { value: '' }));
    for (const row of await optionsFor(refs[key]))
      input.append(el('option', display(row) + ' · ' + row.id.slice(0, 8), { value: row.id }));
  } else if (base.enum) {
    input = el('select');
    if (!required) input.append(el('option', '— None —', { value: '' }));
    for (const v of base.enum) input.append(el('option', v, { value: v }));
  } else if (key === 'description') input = el('textarea');
  else
    input = el('input', undefined, {
      type: base.type === 'integer' || base.type === 'number' ? 'number' : 'text',
    });
  input.name = key;
  input.required = required;
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
    allocation ? 'Allocate IP address' : existing ? 'Save changes' : 'Create record',
    { type: 'submit' },
  );
  buttons.append(
    submit,
    link('Cancel', '/' + path + (existing ? '/' + existing.id : ''), 'button secondary'),
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
  filters.append(el('button', 'Search', { type: 'submit' }));
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(filters)) if (v) next.set(k, v);
    location.search = next.toString();
  });
  main.append(filters);
  if (path !== 'audit-log')
    main.append(link('Create ' + names[path].replace(/s$/, ''), '/' + path + '/new', 'button'));
  const result = await request('/api/v1/' + path + '?' + params.toString());
  main.append(el('p', result.total + ' records', { class: 'muted' }), table(path, result.items));
  const offset = Number(params.get('offset') || 0),
    limit = Number(params.get('limit') || 50);
  const pager = el('div', undefined, { class: 'actions' });
  if (offset > 0) {
    const prev = new URLSearchParams(params);
    prev.set('offset', Math.max(0, offset - limit));
    pager.append(link('Previous', '?' + prev.toString(), 'button secondary'));
  }
  if (offset + result.items.length < result.total) {
    const next = new URLSearchParams(params);
    next.set('offset', offset + limit);
    pager.append(link('Next', '?' + next.toString(), 'button secondary'));
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
  actions.append(link('Back to ' + names[path], '/' + path, 'button secondary'));
  if (path !== 'audit-log') {
    actions.append(link('Edit', '?edit', 'button'));
    const remove = el('button', path === 'ip-addresses' ? 'Release IP address' : 'Delete', {
      class: 'danger',
      type: 'button',
    });
    remove.addEventListener('click', async () => {
      if (
        !confirm(
          'Delete this record? Dependent allocations are retained; required relationships may prevent deletion.',
        )
      )
        return;
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
  if (path === 'prefixes') actions.append(link('Allocate IP address', '?allocate', 'button'));
  if (path === 'devices' || path === 'virtual-machines')
    actions.append(
      link(
        'Add interface',
        '/interfaces/new?' + (path === 'devices' ? 'device_id' : 'virtual_machine_id') + '=' + id,
        'button',
      ),
    );
  if (path === 'interfaces')
    actions.append(link('Register IP address', '/ip-addresses/new?interface_id=' + id, 'button'));
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
    main.append(
      el('h1', 'Infrastructure inventory'),
      el('p', 'Manage physical devices, virtual machines and network allocations in one place.', {
        class: 'muted',
      }),
    );
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
  if (path === 'docs') {
    main.append(
      el('h1', 'REST API'),
      el('p', spec.info.description),
      link('OpenAPI JSON', '/openapi.json'),
    );
    for (const [url, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const section = el('details');
        section.append(
          el('summary', method.toUpperCase() + ' ' + url + ' — ' + operation.summary),
          el('pre', JSON.stringify(operation, null, 2)),
        );
        main.append(section);
      }
    }
    return;
  }
  if (!names[path]) throw new Error('Page not found.');
  main.append(el('h1', names[path]));
  if (id === 'new' && path !== 'audit-log') await editor(path);
  else if (id) await detailPage(path, id);
  else await listPage(path);
}
render().catch(errorBox);
`;
