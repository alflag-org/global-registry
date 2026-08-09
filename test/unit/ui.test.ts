import { describe, expect, it } from 'vitest';
import type {
  Actor,
  Drift,
  Resource,
  ResourceRelationship,
} from '../../src/domain/models/global-registry';
import { accessClientScript } from '../../src/ui/client/access';
import { formsClientScript } from '../../src/ui/client/forms';
import { renderAccessCreatePage } from '../../src/ui/pages/access-create';
import { renderAccessDetailPage } from '../../src/ui/pages/access-detail';
import { renderAccessListPage } from '../../src/ui/pages/access-list';
import { renderAccessRequiredPage } from '../../src/ui/pages/access-required';
import { renderResourcesPage } from '../../src/ui/pages/resources';
import { renderResourceDetailPage } from '../../src/ui/pages/resource-detail';
import { renderShell } from '../../src/ui/shell';
import { styles } from '../../src/ui/styles';

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'actor-1',
    identity: 'access:subject-1',
    displayName: 'Registry Admin',
    role: 'admin',
    active: true,
    revision: 3,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

describe('access management UI', () => {
  it('shows access management only to administrators and exposes the API reference to all actors', () => {
    const adminHtml = renderShell({
      actor: actor(),
      currentPath: '/ui/access',
      title: 'アクセス管理',
      body: '<p>content</p>',
    });
    const readonlyHtml = renderShell({
      actor: actor({ id: 'actor-readonly', role: 'readonly' }),
      currentPath: '/ui',
      title: '概要',
      body: '<p>content</p>',
    });

    expect(adminHtml).toContain('href="/ui/access"');
    expect(readonlyHtml).not.toContain('href="/ui/access"');
    expect(adminHtml).toContain('href="/docs"');
    expect(readonlyHtml).toContain('href="/docs"');
  });

  it('renders searchable actor data without allowing stored HTML to execute', () => {
    const maliciousActor = actor({
      identity: 'access:subject&2',
      displayName: '<img src=x onerror=alert(1)>',
    });
    const page = renderAccessListPage({
      actors: [maliciousActor],
      searchParams: new URLSearchParams(),
    });

    expect(page.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(page.body).toContain('access:subject&amp;2');
    expect(page.body).toContain('name="principalType"');
    expect(page.body).toContain('name="role"');
    expect(page.body).toContain('name="status"');
    expect(page.body).toContain('name="q"');
  });

  it('renders create and compare-and-swap edit forms without credential or delete controls', () => {
    const createPage = renderAccessCreatePage();
    const detailPage = renderAccessDetailPage({
      actor: actor(),
      currentActor: actor(),
    });

    for (const field of ['identity', 'displayName', 'role']) {
      expect(createPage.body).toContain(`name="${field}"`);
    }
    expect(createPage.body).not.toContain('name="secret"');
    expect(createPage.body).not.toContain('name="credential"');
    expect(createPage.body).toContain('pattern="(?:access|service):(?:\\S|\\S.*\\S)"');
    expect(detailPage.body).toContain('data-api-method="PATCH"');
    expect(detailPage.body).toContain('name="expectedRevision" value="3"');
    expect(detailPage.body).toContain('name="active"');
    expect(detailPage.body).not.toContain('削除する');
  });

  it('provides explicit conflict and administrator-safety feedback', () => {
    expect(formsClientScript).toContain("error.code === 'revision_conflict'");
    expect(formsClientScript).toContain("error.code === 'last_active_admin'");
    expect(formsClientScript).toContain("error.code === 'self_lockout'");
    expect(formsClientScript).toContain("error.code === 'invalid_request'");
    expect(formsClientScript).not.toContain('return error.message');
    expect(accessClientScript).toContain('window.confirm');
    expect(accessClientScript).toContain('自分自身の権限を変更します');
  });

  it('limits the onboarding page to the escaped current principal identity', () => {
    const html = renderAccessRequiredPage({
      identity: 'access:subject<&>',
      type: 'human',
    });

    expect(html).toContain('access:subject&lt;&amp;&gt;');
    expect(html).not.toContain('access:subject<&>');
    expect(html).toContain('Identityをコピー');
    expect(html).toContain('<link rel="stylesheet" href="/ui/assets/app.css" />');
    expect(html).toContain('<script type="module" src="/ui/assets/app.js"></script>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script type="module">');
    expect(html).not.toContain('アクセス管理');
    expect(html).not.toContain('リソース');
    expect(html).not.toContain('監査ログ');
  });

  it('includes keyboard focus affordances and a narrow-screen layout', () => {
    const html = renderShell({
      actor: actor(),
      currentPath: '/ui',
      title: '概要',
      body: '<p>content</p>',
    });

    expect(html).toContain('class="skip-link"');
    expect(html).toContain('id="main-content" tabindex="-1"');
    expect(html).toContain('<link rel="stylesheet" href="/ui/assets/app.css" />');
    expect(html).toContain('<script type="module" src="/ui/assets/app.js"></script>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script type="module">');
    expect(styles).toContain(':focus-visible');
    expect(styles).toContain('@media (max-width: 680px)');
    expect(styles).toContain('.table-wrap');
  });

  it('renders a bounded resource page cursor without exposing raw query text', () => {
    const page = renderResourcesPage(
      [
        {
          id: 'resource-1',
          key: 'site-01',
          kind: 'compute',
          name: 'Site 01',
          lifecycleState: 'ready',
          revision: 1,
          placement: {},
          specOverrides: {},
          spec: {},
          createdAt: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:00:00.000Z',
        },
      ],
      'cursor/key&value',
    );

    expect(page.body).toContain('href="/ui/resources?cursor=cursor%2Fkey%26value"');
    expect(page.body).not.toContain('cursor/key&value');
  });

  it('preserves independent resource-detail cursors in the UI pagination links', () => {
    const resource: Resource = {
      id: 'resource-parent',
      key: 'parent',
      kind: 'compute',
      name: 'Parent',
      placement: {},
      specOverrides: {},
      spec: {},
      lifecycleState: 'ready',
      revision: 1,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
    const relationship: ResourceRelationship = {
      id: 'rel-001',
      sourceResourceId: resource.id,
      targetResourceId: 'resource-target',
      relationshipType: 'uses_network',
      revision: 1,
      createdAt: '2026-07-28T00:00:00.000Z',
      createdBy: 'actor-1',
    };
    const drift: Drift = {
      id: 'drift-001',
      resourceId: resource.id,
      severity: 'low',
      status: 'open',
      expected: {},
      observed: {},
      revision: 1,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      createdBy: 'actor-1',
    };
    const page = renderResourceDetailPage({
      detail: {
        resource,
        binding: null,
        health: null,
        relationships: [relationship],
        drifts: [drift],
        relationshipsNextCursor: 'rel-010',
        driftsNextCursor: 'drift-010',
      },
      allResources: [resource],
      events: [],
      actor: actor(),
      query: { relationshipCursor: 'rel-005', driftCursor: 'drift-005' },
    });

    expect(page.body).toContain(
      'href="/ui/resources/parent?relationshipCursor=rel-010&driftCursor=drift-005"',
    );
    expect(page.body).toContain(
      'href="/ui/resources/parent?driftCursor=drift-010&relationshipCursor=rel-005"',
    );
  });
});
