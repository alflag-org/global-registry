import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertPortableExportChunk,
  assertPortableExportManifest,
  manifestChecksumPayload,
  PORTABLE_EXPORT_ENTITIES,
} from '../../src/application/registry-snapshot';
import { D1GlobalRegistryRepository } from '../../src/adapters/d1/repository';
import { R2ExportWriter } from '../../src/adapters/r2/exporter';
import { R2ObservationArchiver } from '../../src/adapters/r2/observation-archiver';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object JSON response.');
  }
  return value as JsonRecord;
}

function exportsBucket(): R2Bucket {
  if (env.EXPORTS_BUCKET === undefined) throw new Error('test R2 binding is unavailable');
  return env.EXPORTS_BUCKET;
}

async function checksum(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function headers(identity: string, json = false): Headers {
  const result = new Headers({
    host: 'localhost',
    'x-global-registry-dev-secret': env.LOCAL_AUTH_SECRET,
    'x-global-registry-dev-identity': identity,
    Accept: 'application/json',
  });
  if (json) result.set('content-type', 'application/json');
  return result;
}

async function request(identity: string, path: string, init?: RequestInit): Promise<Response> {
  const requestHeaders = headers(identity, init?.body !== undefined);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, name) => requestHeaders.set(name, value));
  }
  return SELF.fetch(new Request(`http://localhost${path}`, { ...init, headers: requestHeaders }));
}

function computeResourceBody(key: string, name = key): JsonRecord {
  return {
    key,
    kind: 'compute',
    kindVersion: 1,
    name,
    placement: { locationKey: 'site-01' },
    specOverrides: {
      substrate: 'vm',
      architecture: 'amd64',
      vcpu: 2,
      memoryMiB: 4096,
    },
  };
}

function networkResourceBody(key: string, name = key): JsonRecord {
  return {
    key,
    kind: 'network',
    kindVersion: 1,
    name,
    placement: { locationKey: 'site-01' },
    specOverrides: {
      addressFamily: 'ipv4',
      cidrs: ['10.0.0.0/24'],
    },
  };
}

describe.sequential('control-plane API', () => {
  beforeAll(async () => {
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        )
           VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-admin',
        'access:test-admin',
        'Test Admin',
        'admin',
        createdAt,
        createdAt,
        'actor-admin',
        'actor-admin',
      ),
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        )
           VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-observer',
        'access:test-observer',
        'Test Observer',
        'observer',
        createdAt,
        createdAt,
        'actor-admin',
        'actor-admin',
      ),
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        )
           VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-operator',
        'access:test-operator',
        'Test Operator',
        'operator',
        createdAt,
        createdAt,
        'actor-admin',
        'actor-admin',
      ),
      env.DB.prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        )
           VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      ).bind(
        'actor-provisioner',
        'access:test-provisioner',
        'Test Provisioner',
        'provisioner',
        createdAt,
        createdAt,
        'actor-admin',
        'actor-admin',
      ),
    ]);
    const location = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'site-01',
        kind: 'location',
        kindVersion: 1,
        name: 'KANAGAWA01',
        placement: {},
        specOverrides: { category: 'site' },
      }),
    });
    expect(location.status).toBe(201);
  });

  it('enforces immutable globally-unique resource keys and revision CAS', async () => {
    const create = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify(computeResourceBody('web-01', 'Web 01')),
    });
    expect(create.status).toBe(201);
    const created = asRecord(await create.json());
    expect(created.lifecycleState).toBe('absent');
    expect(created.revision).toBe(1);

    const duplicate = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify(computeResourceBody('web-01', 'Duplicate')),
    });
    expect(duplicate.status).toBe(409);

    const invalidCreate = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        ...computeResourceBody('invalid-compute'),
        specOverrides: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 2,
          memoryMiB: 4096,
          vmid: 100,
        },
      }),
    });
    expect(invalidCreate.status).toBe(422);
    expect(asRecord(asRecord(await invalidCreate.json()).error).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_field', path: 'specOverrides' }),
      ]),
    );

    const invalidUpdate = await request('access:test-admin', '/api/v1/resources/web-01', {
      method: 'PATCH',
      body: JSON.stringify({
        specOverrides: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 2,
          memoryMiB: 4096,
          vmid: 100,
        },
        expectedRevision: 1,
      }),
    });
    expect(invalidUpdate.status).toBe(422);

    const stalePatch = await request('access:test-admin', '/api/v1/resources/web-01', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Web 01 Changed', expectedRevision: 99 }),
    });
    expect(stalePatch.status).toBe(409);
  });

  it('maintains Access actor mappings with compare-and-swap updates', async () => {
    const create = await request('access:test-admin', '/api/v1/actors', {
      method: 'POST',
      body: JSON.stringify({
        identity: 'access:test-readonly',
        displayName: 'Read Only Test',
        role: 'readonly',
      }),
    });
    expect(create.status).toBe(201);
    const created = asRecord(await create.json());
    const actorId = String(created.id);

    const deactivate = await request('access:test-admin', `/api/v1/actors/${actorId}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: false, expectedRevision: 1 }),
    });
    expect(deactivate.status).toBe(200);
    expect(asRecord(await deactivate.json()).active).toBe(false);

    const stale = await request('access:test-admin', `/api/v1/actors/${actorId}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: true, expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);
  });

  it('materializes profile defaults as the resource effective specification', async () => {
    const profile = await request('access:test-admin', '/api/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({
        key: 'compute-defaults',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 2,
          memoryMiB: 4096,
        },
      }),
    });
    expect(profile.status).toBe(201);

    const resource = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'profiled-web',
        kind: 'compute',
        kindVersion: 1,
        name: 'Profiled Web',
        placement: { locationKey: 'site-01' },
        profile: { key: 'compute-defaults', version: 1 },
        specOverrides: { memoryMiB: 8192 },
      }),
    });
    expect(resource.status).toBe(201);
    expect(asRecord(await resource.json()).spec).toEqual({
      substrate: 'vm',
      architecture: 'amd64',
      vcpu: 2,
      memoryMiB: 8192,
    });

    const secondProfileVersion = await request('access:test-admin', '/api/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({
        key: 'compute-defaults',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 4,
          memoryMiB: 4096,
        },
        expectedRevision: 1,
      }),
    });
    expect(secondProfileVersion.status).toBe(201);

    const profileUpgrade = await request('access:test-admin', '/api/v1/resources/profiled-web', {
      method: 'PATCH',
      body: JSON.stringify({
        profile: { key: 'compute-defaults', version: 2 },
        expectedRevision: 1,
      }),
    });
    expect(profileUpgrade.status).toBe(422);
    expect(asRecord(await profileUpgrade.json()).error).toMatchObject({
      code: 'invalid_request',
    });

    const profileRemoval = await request('access:test-admin', '/api/v1/resources/profiled-web', {
      method: 'PATCH',
      body: JSON.stringify({
        profile: null,
        specOverrides: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 8,
          memoryMiB: 16384,
        },
        expectedRevision: 2,
      }),
    });
    expect(profileRemoval.status).toBe(422);
    expect(asRecord(await profileRemoval.json()).error).toMatchObject({
      code: 'invalid_request',
    });

    const incompleteProfileVersion = await request('access:test-admin', '/api/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({
        key: 'compute-defaults',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: { memoryMiB: 4096 },
        expectedRevision: 2,
      }),
    });
    expect(incompleteProfileVersion.status).toBe(201);
    const invalidRecalculation = await request(
      'access:test-admin',
      '/api/v1/resources/profiled-web',
      {
        method: 'PATCH',
        body: JSON.stringify({
          profile: { key: 'compute-defaults', version: 3 },
          specOverrides: {},
          expectedRevision: 1,
        }),
      },
    );
    expect(invalidRecalculation.status).toBe(422);
    expect(asRecord(await invalidRecalculation.json()).error).toMatchObject({
      code: 'invalid_request',
    });

    const highMemoryProfileVersion = await request('access:test-admin', '/api/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({
        key: 'compute-defaults',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 4,
          memoryMiB: 16384,
        },
        expectedRevision: 3,
      }),
    });
    expect(highMemoryProfileVersion.status).toBe(201);
    const profilePolicy = await request('access:test-admin', '/api/v1/policies', {
      method: 'POST',
      body: JSON.stringify({
        namespace: 'compute',
        key: 'profile-limit',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: { memoryMiB: { maximum: 8192 } },
      }),
    });
    expect(profilePolicy.status).toBe(201);
    const policyInvalidCreate = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        ...computeResourceBody('policy-invalid-create'),
        policy: { namespace: 'compute', key: 'profile-limit', version: 1 },
        specOverrides: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 4,
          memoryMiB: 16384,
        },
      }),
    });
    expect(policyInvalidCreate.status).toBe(422);
    expect(asRecord(await policyInvalidCreate.json()).error).toMatchObject({
      code: 'policy_violation',
    });
    const profilePolicyResource = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'profile-policy-host',
        kind: 'compute',
        kindVersion: 1,
        name: 'Profile Policy Host',
        placement: { locationKey: 'site-01' },
        profile: { key: 'compute-defaults', version: 2 },
        policy: { namespace: 'compute', key: 'profile-limit', version: 1 },
        specOverrides: {},
      }),
    });
    expect(profilePolicyResource.status).toBe(201);
    const policyInvalidRecalculation = await request(
      'access:test-admin',
      '/api/v1/resources/profile-policy-host',
      {
        method: 'PATCH',
        body: JSON.stringify({
          profile: { key: 'compute-defaults', version: 4 },
          expectedRevision: 1,
        }),
      },
    );
    expect(policyInvalidRecalculation.status).toBe(422);
    expect(asRecord(await policyInvalidRecalculation.json()).error).toMatchObject({
      code: 'invalid_request',
    });

    const wrongKind = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'invalid-profile-kind',
        kind: 'network',
        kindVersion: 1,
        name: 'Invalid Profile Kind',
        placement: { locationKey: 'site-01' },
        profile: { key: 'compute-defaults', version: 1 },
        specOverrides: {},
      }),
    });
    expect(wrongKind.status).toBe(422);

    const referenceGuardRepository = new D1GlobalRegistryRepository(env.DB);
    const profileSummary = await referenceGuardRepository.getProfileSummary('compute-defaults');
    const policySummary = await referenceGuardRepository.getPolicySummary(
      'compute',
      'profile-limit',
    );
    expect(profileSummary).not.toBeNull();
    expect(policySummary).not.toBeNull();
    if (profileSummary === null || policySummary === null) {
      throw new Error('Reference guard fixtures were not created.');
    }
    await expect(
      referenceGuardRepository.createResource({
        actorId: 'actor-admin',
        key: 'stale-reference-create',
        kind: 'compute',
        kindVersion: 1,
        initialState: 'absent',
        name: 'Stale Reference Create',
        placement: { locationKey: 'site-01' },
        specOverrides: {},
        spec: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 4,
          memoryMiB: 4096,
        },
        profile: { key: 'compute-defaults', version: 2 },
        policy: { namespace: 'compute', key: 'profile-limit', version: 1 },
        profileGuard: {
          expectedRevision: profileSummary.revision,
          expectedStatus: profileSummary.status,
        },
        policyGuard: {
          expectedRevision: policySummary.revision + 1,
          expectedStatus: policySummary.status,
        },
      }),
    ).rejects.toMatchObject({ code: 'resource_dependencies_changed', status: 409 });
    expect(await referenceGuardRepository.getResource('stale-reference-create')).toBeNull();
    const staleReferenceEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM events WHERE resource_key = 'stale-reference-create'`,
    ).first<{ count: number }>();
    expect(Number(staleReferenceEvents?.count)).toBe(0);
  });

  it('returns validation errors rather than internal errors for malformed kind queries', async () => {
    const response = await request('access:test-admin', '/api/v1/resources?kind=InvalidKind');
    expect(response.status).toBe(400);
    expect(asRecord(await response.json()).error).toMatchObject({ code: 'invalid_query' });
  });

  it('pins Resources to immutable extensible kind definitions', async () => {
    const definitionKey = 'example.internal-appliance';
    const firstDefinition = await request(
      'access:test-admin',
      '/api/v1/resource-kind-definitions',
      {
        method: 'POST',
        body: JSON.stringify({
          key: definitionKey,
          states: ['absent', 'ready', 'retired'],
          initialState: 'absent',
          terminalStates: ['retired'],
          transitions: [
            { from: 'absent', to: 'ready', destructive: false },
            { from: 'ready', to: 'retired', destructive: true },
          ],
          placementMode: 'located',
          relationshipRules: [{ relationshipType: 'depends_on', targetKinds: [definitionKey] }],
        }),
      },
    );
    expect(firstDefinition.status).toBe(201);
    expect(asRecord(await firstDefinition.json())).toMatchObject({
      key: definitionKey,
      version: 1,
      specificationMode: 'opaque',
      revision: 1,
    });

    const createdResource = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'extension-appliance',
        kind: definitionKey,
        kindVersion: 1,
        name: 'Extension Appliance',
        placement: { locationKey: 'site-01' },
        specOverrides: { model: 'appliance-v1', capacity: 2 },
      }),
    });
    expect(createdResource.status).toBe(201);
    expect(asRecord(await createdResource.json())).toMatchObject({
      kind: definitionKey,
      kindVersion: 1,
      lifecycleState: 'absent',
    });

    const secretLikeResource = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'extension-secret',
        kind: definitionKey,
        kindVersion: 1,
        name: 'Extension Secret',
        placement: { locationKey: 'site-01' },
        specOverrides: { apiToken: 'must-not-be-persisted' },
      }),
    });
    expect(secretLikeResource.status).toBe(422);
    expect(asRecord(await secretLikeResource.json()).error).toMatchObject({
      code: 'secret_like_json_key',
    });

    const secondDefinition = await request(
      'access:test-admin',
      '/api/v1/resource-kind-definitions',
      {
        method: 'POST',
        body: JSON.stringify({
          key: definitionKey,
          states: ['absent', 'configured', 'ready', 'retired'],
          initialState: 'absent',
          terminalStates: ['retired'],
          transitions: [
            { from: 'absent', to: 'configured', destructive: false },
            { from: 'configured', to: 'ready', destructive: false },
            { from: 'ready', to: 'retired', destructive: true },
          ],
          placementMode: 'located',
          relationshipRules: [{ relationshipType: 'depends_on', targetKinds: [definitionKey] }],
          expectedRevision: 1,
        }),
      },
    );
    expect(secondDefinition.status).toBe(201);
    expect(asRecord(await secondDefinition.json())).toMatchObject({
      key: definitionKey,
      version: 2,
      revision: 2,
    });

    const operationResponse = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'configure-extension',
        resources: [
          {
            resourceKey: 'extension-appliance',
            sourceState: 'absent',
            targetState: 'ready',
            resourceRevision: 1,
          },
        ],
      }),
    });
    expect(operationResponse.status).toBe(201);
    const operationId = String(asRecord(await operationResponse.json()).id);
    const lockResponse = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/extension-appliance'], leaseSeconds: 120 }),
      },
    );
    expect(lockResponse.status).toBe(201);
    const fencingToken = Number(
      (asRecord(await lockResponse.json()).items as Array<JsonRecord>)[0]?.fencingToken,
    );

    const start = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/extension-appliance',
          fencingToken,
        }),
      },
    );
    expect(start.status).toBe(200);

    const transition = await request(
      'access:test-provisioner',
      '/api/v1/resources/extension-appliance/transitions',
      {
        method: 'POST',
        body: JSON.stringify({
          targetState: 'ready',
          expectedRevision: 1,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(transition.status).toBe(200);
    expect(asRecord(await transition.json())).toMatchObject({
      kindVersion: 1,
      lifecycleState: 'ready',
    });

    const complete = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 2,
          lockScope: 'resource/extension-appliance',
          fencingToken,
        }),
      },
    );
    expect(complete.status).toBe(200);

    const release = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks/release`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/extension-appliance'] }),
      },
    );
    expect(release.status).toBe(204);

    const detail = await request('access:test-admin', '/api/v1/resources/extension-appliance');
    expect(detail.status).toBe(200);
    expect(asRecord(asRecord(await detail.json()).resource)).toMatchObject({
      kind: definitionKey,
      kindVersion: 1,
      lifecycleState: 'ready',
    });

    const firstVersion = await request(
      'access:test-admin',
      `/api/v1/resource-kind-definitions/${definitionKey}/versions/1`,
    );
    expect(firstVersion.status).toBe(200);
    const firstVersionBody = asRecord(await firstVersion.json());
    expect(firstVersionBody.version).toBe(1);
    expect(firstVersionBody.transitions).toEqual(
      expect.arrayContaining([{ from: 'absent', to: 'ready', destructive: false }]),
    );

    const definitions = await request('access:test-admin', '/api/v1/resource-kind-definitions');
    expect(definitions.status).toBe(200);
    expect(asRecord(await definitions.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: definitionKey, version: 2, revision: 2 }),
      ]),
    );

    const deprecated = await request(
      'access:test-admin',
      `/api/v1/resource-kind-definitions/${definitionKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'deprecated', expectedRevision: 2 }),
      },
    );
    expect(deprecated.status).toBe(200);
    expect(asRecord(await deprecated.json())).toMatchObject({
      status: 'deprecated',
      revision: 3,
    });

    const versionWhileDeprecated = await request(
      'access:test-admin',
      '/api/v1/resource-kind-definitions',
      {
        method: 'POST',
        body: JSON.stringify({
          key: definitionKey,
          states: ['absent', 'ready', 'retired'],
          initialState: 'absent',
          terminalStates: ['retired'],
          transitions: [
            { from: 'absent', to: 'ready', destructive: false },
            { from: 'ready', to: 'retired', destructive: true },
          ],
          placementMode: 'located',
          relationshipRules: [],
          expectedRevision: 3,
        }),
      },
    );
    expect(versionWhileDeprecated.status).toBe(409);
    expect(asRecord(await versionWhileDeprecated.json()).error).toMatchObject({
      code: 'resource_kind_definition_not_active',
    });

    const retired = await request(
      'access:test-admin',
      `/api/v1/resource-kind-definitions/${definitionKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'retired', expectedRevision: 3 }),
      },
    );
    expect(retired.status).toBe(200);
    expect(asRecord(await retired.json())).toMatchObject({ status: 'retired', revision: 4 });

    const reactivate = await request(
      'access:test-admin',
      `/api/v1/resource-kind-definitions/${definitionKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active', expectedRevision: 4 }),
      },
    );
    expect(reactivate.status).toBe(409);
    expect(asRecord(await reactivate.json()).error).toMatchObject({
      code: 'resource_kind_definition_retired',
    });

    const definitionEvents = await env.DB.prepare(
      `SELECT event_type
         FROM events
        WHERE json_extract(payload_json, '$.key') = ?
        ORDER BY occurred_at, event_id`,
    )
      .bind(definitionKey)
      .all<{ event_type: string }>();
    expect(definitionEvents.results.map(({ event_type: eventType }) => eventType)).toEqual([
      'resource_kind_definition.created',
      'resource_kind_definition.version_created',
      'resource_kind_definition.status_changed',
      'resource_kind_definition.status_changed',
    ]);
  });

  it('records health without deriving lifecycle and rejects observer lifecycle writes', async () => {
    const health = await request('access:test-observer', '/api/v1/resources/web-01/health', {
      method: 'PUT',
      body: JSON.stringify({
        status: 'degraded',
        reason: 'synthetic test',
        observedAt: new Date().toISOString(),
        expectedRevision: 1,
      }),
    });
    expect(health.status).toBe(200);
    const resource = await request('access:test-admin', '/api/v1/resources/web-01');
    const detail = asRecord(await resource.json());
    expect(asRecord(detail.resource).lifecycleState).toBe('absent');
    expect(asRecord(detail.health).status).toBe('degraded');

    const forbidden = await request(
      'access:test-observer',
      '/api/v1/resources/web-01/transitions',
      {
        method: 'POST',
        body: JSON.stringify({
          targetState: 'allocated',
          expectedRevision: 1,
          operationId: 'op_forbidden',
          fencingToken: 1,
        }),
      },
    );
    expect(forbidden.status).toBe(403);
  });

  it('requires a current lease and fencing token for lifecycle transitions', async () => {
    const create = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify(computeResourceBody('lock-host', 'Lock Host')),
    });
    expect(create.status).toBe(201);

    const operationResponse = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'provision',
        intent: { test: true },
        resources: [
          {
            resourceKey: 'lock-host',
            sourceState: 'absent',
            targetState: 'allocated',
            resourceRevision: 1,
          },
        ],
        steps: [{ position: 0, name: 'Allocate', gate: { lockRequired: true } }],
      }),
    });
    expect(operationResponse.status).toBe(201);
    const operation = asRecord(await operationResponse.json());
    const operationId = String(operation.id);

    const lockResponse = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 120 }),
      },
    );
    expect(lockResponse.status).toBe(201);
    const locks = asRecord(await lockResponse.json());
    const lockItems = locks.items as Array<JsonRecord>;
    let fencingToken = Number(lockItems[0]?.fencingToken);
    expect(fencingToken).toBeGreaterThan(0);

    const unplannedScope = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/not-in-operation'], leaseSeconds: 120 }),
      },
    );
    expect(unplannedScope.status).toBe(409);
    expect(asRecord(await unplannedScope.json()).error).toMatchObject({
      code: 'lock_scope_not_planned',
    });

    const wrongCaller = await request(
      'access:test-operator',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 120 }),
      },
    );
    expect(wrongCaller.status).toBe(403);
    expect(asRecord(await wrongCaller.json()).error).toMatchObject({
      code: 'forbidden',
    });

    const competingOperation = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'competing-provision',
        intent: { test: true },
        resources: [
          {
            resourceKey: 'lock-host',
            sourceState: 'absent',
            targetState: 'allocated',
            resourceRevision: 1,
          },
        ],
        steps: [{ position: 0, name: 'Allocate', gate: { lockRequired: true } }],
      }),
    });
    expect(competingOperation.status).toBe(201);
    const competingOperationId = String(asRecord(await competingOperation.json()).id);
    const conflict = await request(
      'access:test-provisioner',
      `/api/v1/operations/${competingOperationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 120 }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(asRecord(await conflict.json()).error).toMatchObject({ code: 'lock_conflict' });

    const partialRelease = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks/release`,
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: ['resource/lock-host', 'resource/not-owned'],
        }),
      },
    );
    expect(partialRelease.status).toBe(409);
    expect(
      await env.DB.prepare(`SELECT scope FROM resource_locks WHERE operation_id = ? AND scope = ?`)
        .bind(operationId, 'resource/lock-host')
        .first(),
    ).not.toBeNull();

    const renewed = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks/renew`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 180 }),
      },
    );
    expect(renewed.status).toBe(200);
    const renewedItems = asRecord(await renewed.json()).items as Array<JsonRecord>;
    expect(String(renewedItems[0]?.expiresAt)).not.toBe(String(lockItems[0]?.expiresAt));
    const renewedEvent = await env.DB.prepare(
      `SELECT event_type, actor_id FROM events
       WHERE operation_id = ? AND event_type = 'lock.renewed'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
      .bind(operationId)
      .first<{ event_type: string; actor_id: string }>();
    expect(renewedEvent).toEqual({ event_type: 'lock.renewed', actor_id: 'actor-provisioner' });

    await env.DB.prepare(
      `UPDATE resource_locks SET expires_at = '2000-01-01T00:00:00.000Z'
       WHERE scope = 'resource/lock-host'`,
    ).run();
    const expiredLease = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/lock-host',
          fencingToken,
        }),
      },
    );
    expect(expiredLease.status).toBe(409);
    expect(asRecord(await expiredLease.json()).error).toMatchObject({
      code: 'stale_fencing_token',
    });

    const reacquired = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 120 }),
      },
    );
    expect(reacquired.status).toBe(201);
    const reacquiredItems = asRecord(await reacquired.json()).items as Array<JsonRecord>;
    fencingToken = Number(reacquiredItems[0]?.fencingToken);
    expect(fencingToken).toBeGreaterThan(Number(lockItems[0]?.fencingToken));

    const start = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/lock-host',
          fencingToken,
        }),
      },
    );
    expect(start.status).toBe(200);

    const completionRepository = new D1GlobalRegistryRepository(env.DB);
    await expect(
      completionRepository.updateOperationStatus({
        id: operationId,
        sourceStatus: 'running',
        targetStatus: 'succeeded',
        expectedRevision: 2,
        lockScope: 'resource/lock-host',
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({ code: 'operation_completion_required' });
    await expect(
      completionRepository.completeOperation({
        id: operationId,
        expectedRevision: 2,
        lockScope: 'resource/lock-host',
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({
      code: 'operation_completion_incomplete',
      details: {
        incompleteResources: 1,
        incompleteSteps: 1,
        incompleteChanges: 0,
      },
    });
    const unchangedIncompleteOperation = await env.DB.prepare(
      `SELECT status, revision FROM operations WHERE id = ?`,
    )
      .bind(operationId)
      .first<{ status: string; revision: number }>();
    expect(unchangedIncompleteOperation).toEqual({ status: 'running', revision: 2 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE operation_id = ? AND event_type = 'operation.succeeded'`,
      )
        .bind(operationId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const staleFence = await request(
      'access:test-provisioner',
      '/api/v1/resources/lock-host/transitions',
      {
        method: 'POST',
        body: JSON.stringify({
          targetState: 'allocated',
          expectedRevision: 1,
          operationId,
          fencingToken: fencingToken + 1,
        }),
      },
    );
    expect(staleFence.status).toBe(409);

    const transition = await request(
      'access:test-provisioner',
      '/api/v1/resources/lock-host/transitions',
      {
        method: 'POST',
        body: JSON.stringify({
          targetState: 'allocated',
          expectedRevision: 1,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(transition.status).toBe(200);
    expect(asRecord(await transition.json()).lifecycleState).toBe('allocated');

    const incompleteStep = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 2,
          lockScope: 'resource/lock-host',
          fencingToken,
        }),
      },
    );
    expect(incompleteStep.status).toBe(409);
    expect(asRecord(await incompleteStep.json()).error).toMatchObject({
      code: 'operation_completion_incomplete',
    });

    const operationDetail = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}`,
    );
    expect(operationDetail.status).toBe(200);
    const steps = asRecord(await operationDetail.json()).steps as Array<JsonRecord>;
    const stepId = String(steps[0]?.id);

    const step = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/steps/${stepId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'succeeded',
          evidence: { providerAction: 'recorded' },
          expectedRevision: 1,
          lockScope: 'resource/lock-host',
          fencingToken,
        }),
      },
    );
    expect(step.status).toBe(200);

    const complete = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 2,
          lockScope: 'resource/lock-host',
          fencingToken,
        }),
      },
    );
    expect(complete.status).toBe(200);
    expect(asRecord(await complete.json()).status).toBe('succeeded');
    const completionEvents = await env.DB.prepare(
      `SELECT event.event_type, message.topic
       FROM events event JOIN outbox message ON message.event_id = event.event_id
       WHERE event.operation_id = ? AND event.event_type = 'operation.succeeded'`,
    )
      .bind(operationId)
      .all<{ event_type: string; topic: string }>();
    expect(completionEvents.results).toEqual([
      {
        event_type: 'operation.succeeded',
        topic: 'global-registry.operation.succeeded',
      },
    ]);

    const release = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks/release`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'] }),
      },
    );
    expect(release.status).toBe(204);
    expect(
      await env.DB.prepare('SELECT scope FROM resource_locks WHERE operation_id = ?')
        .bind(operationId)
        .first(),
    ).toBeNull();
    const releasedEvent = await env.DB.prepare(
      `SELECT event_type, actor_id FROM events
       WHERE operation_id = ? AND event_type = 'lock.released'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
      .bind(operationId)
      .first<{ event_type: string; actor_id: string }>();
    expect(releasedEvent).toEqual({ event_type: 'lock.released', actor_id: 'actor-provisioner' });

    const releaseRegrantOperation = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'release-regrant-provision',
        intent: { test: true },
        resources: [
          {
            resourceKey: 'lock-host',
            sourceState: 'allocated',
            targetState: 'bootstrapped',
            resourceRevision: 2,
          },
        ],
        steps: [{ position: 0, name: 'Configure', gate: { lockRequired: true } }],
      }),
    });
    expect(releaseRegrantOperation.status).toBe(201);
    const releaseRegrantOperationId = String(asRecord(await releaseRegrantOperation.json()).id);
    const releaseRegrant = await request(
      'access:test-provisioner',
      `/api/v1/operations/${releaseRegrantOperationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/lock-host'], leaseSeconds: 120 }),
      },
    );
    expect(releaseRegrant.status).toBe(201);
    const releaseRegrantItems = asRecord(await releaseRegrant.json()).items as Array<JsonRecord>;
    expect(Number(releaseRegrantItems[0]?.fencingToken)).toBeGreaterThan(fencingToken);
  });

  it('requires a lifecycle transition to match the running operation plan', async () => {
    for (const key of ['planned-host', 'unplanned-host']) {
      const create = await request('access:test-admin', '/api/v1/resources', {
        method: 'POST',
        body: JSON.stringify(computeResourceBody(key)),
      });
      expect(create.status).toBe(201);
    }

    const invalidPlan = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'invalid-transition',
        resources: [
          {
            resourceKey: 'planned-host',
            sourceState: 'absent',
            targetState: 'serving',
            resourceRevision: 1,
          },
        ],
      }),
    });
    expect(invalidPlan.status).toBe(422);

    const operationResponse = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'provision',
        resources: [
          {
            resourceKey: 'planned-host',
            sourceState: 'absent',
            targetState: 'allocated',
            resourceRevision: 1,
          },
        ],
        steps: [{ position: 0, name: 'Allocate', gate: { lockRequired: true } }],
      }),
    });
    expect(operationResponse.status).toBe(201);
    const operation = asRecord(await operationResponse.json());
    const operationId = String(operation.id);

    const locks = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/planned-host'], leaseSeconds: 120 }),
      },
    );
    expect(locks.status).toBe(201);
    const lockItems = asRecord(await locks.json()).items as Array<JsonRecord>;
    const fencingToken = Number(lockItems[0]?.fencingToken);
    expect(fencingToken).toBeGreaterThan(0);

    const start = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/planned-host',
          fencingToken,
        }),
      },
    );
    expect(start.status).toBe(200);

    const transition = await request(
      'access:test-provisioner',
      '/api/v1/resources/unplanned-host/transitions',
      {
        method: 'POST',
        body: JSON.stringify({
          targetState: 'allocated',
          expectedRevision: 1,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(transition.status).toBe(409);
    expect(asRecord(await transition.json()).error).toMatchObject({
      code: 'operation_plan_mismatch',
    });
  });

  it('manages provider bindings, relationships, policies, and drifts through the API', async () => {
    const provider = await request('access:test-admin', '/api/v1/providers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'provider-primary',
        driver: 'example.internal',
        credentialRef: 'TEST_PROVIDER_TOKEN',
        capabilities: {
          resourceKinds: ['compute'],
          features: ['compute.vm', 'compute.cloud-init'],
          architectures: ['amd64'],
        },
        configuration: { region: 'primary', adapterMode: 'managed' },
        mappings: {
          networks: {
            dmz: { bridge: 'vmbr0', vlanTag: 130 },
            lab: { bridge: 'vmbr0', vlanTag: 140 },
          },
          storageClasses: { general: { storage: 'local-lvm' } },
          imageClasses: { 'ubuntu-2404': { templateId: '9000' } },
        },
      }),
    });
    expect(provider.status).toBe(201);
    expect(asRecord(await provider.json())).toMatchObject({
      driver: 'example.internal',
      configuration: { region: 'primary', adapterMode: 'managed' },
    });

    const policy = await request('access:test-admin', '/api/v1/policies', {
      method: 'POST',
      body: JSON.stringify({
        namespace: 'compute',
        key: 'standard',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: {
          allowedArchitectures: ['amd64'],
          requiredProviderCapabilities: ['compute.vm'],
          allowedZones: ['dmz'],
        },
      }),
    });
    expect(policy.status).toBe(201);

    const host = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        ...computeResourceBody('bound-host', 'Bound Host'),
        placement: {
          locationKey: 'site-01',
          zone: 'dmz',
          providerSelector: {
            drivers: ['example.internal'],
            providerIds: ['provider-primary'],
            requiredCapabilities: ['compute.vm'],
          },
        },
        policy: { namespace: 'compute', key: 'standard', version: 1 },
        specOverrides: {
          substrate: 'vm',
          architecture: 'amd64',
          vcpu: 2,
          memoryMiB: 4096,
          imageClass: 'ubuntu-2404',
          storageClass: 'general',
        },
      }),
    });
    expect(host.status).toBe(201);
    const network = await request('access:test-admin', '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify(networkResourceBody('bound-network', 'Bound Network')),
    });
    expect(network.status).toBe(201);

    const operationResponse = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'bind-provider-resource',
        resources: [
          {
            resourceKey: 'bound-host',
            sourceState: 'absent',
            targetState: 'absent',
            resourceRevision: 1,
          },
        ],
        changes: [
          {
            action: 'binding.replace',
            resourceKey: 'bound-host',
            providerId: 'provider-primary',
            providerResourceType: 'qemu',
            providerResourceId: '42',
          },
          {
            action: 'relationship.create',
            resourceKey: 'bound-host',
            targetResourceKey: 'bound-network',
            relationshipType: 'uses_network',
          },
        ],
        steps: [{ position: 0, name: 'Bind provider resource', gate: { lockRequired: true } }],
      }),
    });
    expect(operationResponse.status).toBe(201);
    const operationId = String(asRecord(await operationResponse.json()).id);

    const locks = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/bound-host'], leaseSeconds: 120 }),
      },
    );
    expect(locks.status).toBe(201);
    const lockItems = asRecord(await locks.json()).items as Array<JsonRecord>;
    const fencingToken = Number(lockItems[0]?.fencingToken);

    const start = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/bound-host',
          fencingToken,
        }),
      },
    );
    expect(start.status).toBe(200);

    const atomicGuardRepository = new D1GlobalRegistryRepository(env.DB);
    await env.DB.prepare(`UPDATE operations SET status = 'succeeded' WHERE id = ?`)
      .bind(operationId)
      .run();
    await expect(
      atomicGuardRepository.replaceBinding({
        resourceKey: 'bound-host',
        providerId: 'provider-primary',
        providerResourceType: 'qemu',
        providerResourceId: '42',
        locator: { cluster: 'main' },
        expectedRevision: 1,
        expectedProviderRevision: 1,
        expectedProviderBindingRevision: 0,
        operationId,
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      atomicGuardRepository.createRelationship({
        sourceKey: 'bound-host',
        targetKey: 'bound-network',
        relationshipType: 'uses_network',
        expectedRevision: 1,
        operationId,
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const guardedState = await env.DB.batch([
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM provider_bindings
         WHERE resource_id = (SELECT id FROM resources WHERE key = 'bound-host')`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM resource_relationships
         WHERE source_resource_id = (SELECT id FROM resources WHERE key = 'bound-host')`,
      ),
    ]);
    expect(Number((guardedState[0]?.results[0] as { count?: number } | undefined)?.count)).toBe(0);
    expect(Number((guardedState[1]?.results[0] as { count?: number } | undefined)?.count)).toBe(0);
    await env.DB.prepare(`UPDATE operations SET status = 'running' WHERE id = ?`)
      .bind(operationId)
      .run();
    const changeOperationDetail = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}`,
    );
    expect(changeOperationDetail.status).toBe(200);
    const changeOperationSteps = asRecord(await changeOperationDetail.json())
      .steps as Array<JsonRecord>;
    const changeOperationStep = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/steps/${String(changeOperationSteps[0]?.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'skipped',
          evidence: { reason: 'registry-only changes' },
          expectedRevision: 1,
          lockScope: 'resource/bound-host',
          fencingToken,
        }),
      },
    );
    expect(changeOperationStep.status).toBe(200);
    await expect(
      atomicGuardRepository.completeOperation({
        id: operationId,
        expectedRevision: 2,
        lockScope: 'resource/bound-host',
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({
      code: 'operation_completion_incomplete',
      details: {
        incompleteResources: 0,
        incompleteSteps: 0,
        incompleteChanges: 2,
      },
    });
    await expect(
      atomicGuardRepository.replaceBinding({
        resourceKey: 'bound-host',
        providerId: 'provider-primary',
        providerResourceType: 'qemu',
        providerResourceId: '42',
        locator: { cluster: 'main' },
        expectedRevision: 99,
        expectedProviderRevision: 1,
        expectedProviderBindingRevision: 0,
        operationId,
        fencingToken,
        actorId: 'actor-provisioner',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const bindingRevisionAfterStaleReplace = await env.DB.prepare(
      `SELECT binding_revision FROM providers WHERE id = 'provider-primary'`,
    ).first<{ binding_revision: number }>();
    expect(bindingRevisionAfterStaleReplace?.binding_revision).toBe(0);

    const binding = await request(
      'access:test-provisioner',
      '/api/v1/resources/bound-host/binding',
      {
        method: 'PUT',
        body: JSON.stringify({
          providerId: 'provider-primary',
          providerResourceType: 'qemu',
          providerResourceId: '42',
          locator: { cluster: 'main' },
          expectedRevision: 1,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(binding.status).toBe(200);

    const relationship = await request('access:test-provisioner', '/api/v1/relationships', {
      method: 'POST',
      body: JSON.stringify({
        sourceKey: 'bound-host',
        targetKey: 'bound-network',
        relationshipType: 'uses_network',
        expectedRevision: 2,
        operationId,
        fencingToken,
      }),
    });
    expect(relationship.status).toBe(201);
    const relationshipRecord = asRecord(await relationship.json());

    const duplicateRelationship = await request(
      'access:test-provisioner',
      '/api/v1/relationships',
      {
        method: 'POST',
        body: JSON.stringify({
          sourceKey: 'bound-host',
          targetKey: 'bound-network',
          relationshipType: 'uses_network',
          expectedRevision: 3,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(duplicateRelationship.status).toBe(409);

    const selfRelationship = await request('access:test-provisioner', '/api/v1/relationships', {
      method: 'POST',
      body: JSON.stringify({
        sourceKey: 'bound-host',
        targetKey: 'bound-host',
        relationshipType: 'depends_on',
        expectedRevision: 3,
        operationId,
        fencingToken,
      }),
    });
    expect(selfRelationship.status).toBe(422);

    const boundHostBeforeGuardChecks = await atomicGuardRepository.getResource('bound-host');
    const providerBeforeGuardChecks = await atomicGuardRepository.getProvider('provider-primary');
    expect(boundHostBeforeGuardChecks).not.toBeNull();
    expect(providerBeforeGuardChecks).not.toBeNull();
    if (boundHostBeforeGuardChecks === null || providerBeforeGuardChecks === null) {
      throw new Error('Guard check fixtures were not created.');
    }
    await expect(
      atomicGuardRepository.updateResource({
        actorId: 'actor-admin',
        key: boundHostBeforeGuardChecks.key,
        name: boundHostBeforeGuardChecks.name,
        placement: boundHostBeforeGuardChecks.placement,
        specOverrides: boundHostBeforeGuardChecks.specOverrides,
        spec: boundHostBeforeGuardChecks.spec,
        profile: boundHostBeforeGuardChecks.profile ?? null,
        policy: boundHostBeforeGuardChecks.policy ?? null,
        boundProviderGuard: {
          providerId: providerBeforeGuardChecks.id,
          expectedRevision: 99,
        },
        expectedRevision: boundHostBeforeGuardChecks.revision,
      }),
    ).rejects.toMatchObject({ code: 'resource_dependencies_changed', status: 409 });
    await expect(
      atomicGuardRepository.updateProvider({
        id: providerBeforeGuardChecks.id,
        expectedRevision: providerBeforeGuardChecks.revision,
        expectedBindingRevision: providerBeforeGuardChecks.bindingRevision,
        expectedBoundResourceCount: 1,
        actorId: 'actor-admin',
        driver: providerBeforeGuardChecks.driver,
        credentialRef: providerBeforeGuardChecks.credentialRef,
        status: providerBeforeGuardChecks.status,
        capabilities: providerBeforeGuardChecks.capabilities,
        mappings: providerBeforeGuardChecks.mappings,
        expectedBoundResources: [
          {
            id: boundHostBeforeGuardChecks.id,
            key: boundHostBeforeGuardChecks.key,
            revision: 99,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'provider_bound_resources_changed', status: 409 });
    expect((await atomicGuardRepository.getResource('bound-host'))?.revision).toBe(
      boundHostBeforeGuardChecks.revision,
    );
    expect((await atomicGuardRepository.getProvider('provider-primary'))?.revision).toBe(
      providerBeforeGuardChecks.revision,
    );

    const drift = await request('access:test-observer', '/api/v1/drifts', {
      method: 'POST',
      body: JSON.stringify({
        resourceKey: 'bound-host',
        severity: 'high',
        expected: { lifecycle: 'ready' },
        observed: { lifecycle: 'absent' },
      }),
    });
    expect(drift.status).toBe(201);
    const driftRecord = asRecord(await drift.json());

    const acknowledged = await request(
      'access:test-observer',
      `/api/v1/drifts/${encodeURIComponent(String(driftRecord.id))}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'acknowledged', expectedRevision: 1 }),
      },
    );
    expect(acknowledged.status).toBe(200);

    const secretConfigurationPatch = await request(
      'access:test-admin',
      '/api/v1/providers/provider-primary',
      {
        method: 'PATCH',
        body: JSON.stringify({
          configuration: { apiToken: 'must-not-be-stored' },
          expectedRevision: 1,
        }),
      },
    );
    expect(secretConfigurationPatch.status).toBe(422);

    const incompatibleCapabilityPatch = await request(
      'access:test-admin',
      '/api/v1/providers/provider-primary',
      {
        method: 'PATCH',
        body: JSON.stringify({
          capabilities: {
            resourceKinds: ['compute'],
            features: [],
            architectures: ['amd64'],
          },
          expectedRevision: 1,
        }),
      },
    );
    expect(incompatibleCapabilityPatch.status).toBe(422);

    const retireBoundProvider = await request(
      'access:test-admin',
      '/api/v1/providers/provider-primary',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'retired', expectedRevision: 1 }),
      },
    );
    expect(retireBoundProvider.status).toBe(409);

    const providerPatch = await request('access:test-admin', '/api/v1/providers/provider-primary', {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'disabled',
        mappings: {
          networks: { dmz: { bridge: 'vmbr0', vlanTag: 130 } },
          storageClasses: { general: { storage: 'local-lvm' } },
          imageClasses: { 'ubuntu-2404': { templateId: '9000' } },
        },
        expectedRevision: 1,
      }),
    });
    expect(providerPatch.status).toBe(200);

    const disabledBinding = await request(
      'access:test-provisioner',
      '/api/v1/resources/bound-host/binding',
      {
        method: 'PUT',
        body: JSON.stringify({
          providerId: 'provider-primary',
          providerResourceType: 'qemu',
          providerResourceId: '42',
          locator: { cluster: 'main' },
          expectedRevision: 3,
          operationId,
          fencingToken,
        }),
      },
    );
    expect(disabledBinding.status).toBe(422);
    expect(asRecord(await disabledBinding.json()).error).toMatchObject({
      code: 'provider_incompatible',
    });

    const completeChanges = await request(
      'access:test-provisioner',
      `/api/v1/operations/${operationId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 2,
          lockScope: 'resource/bound-host',
          fencingToken,
        }),
      },
    );
    expect(completeChanges.status).toBe(200);
    expect(asRecord(await completeChanges.json()).status).toBe('succeeded');

    const detail = await request('access:test-admin', '/api/v1/resources/bound-host');
    expect(detail.status).toBe(200);
    expect(asRecord(await detail.json())).toMatchObject({
      binding: { providerId: 'provider-primary', providerResourceId: '42' },
      relationships: [{ relationshipType: 'uses_network' }],
      drifts: [{ status: 'acknowledged', severity: 'high' }],
      resource: { policy: { namespace: 'compute', key: 'standard', version: 1 } },
    });

    const policyVersion = await request('access:test-admin', '/api/v1/policies', {
      method: 'POST',
      body: JSON.stringify({
        namespace: 'compute',
        key: 'standard',
        resourceKind: 'compute',
        resourceKindVersion: 1,
        spec: { memoryMiB: { maximum: 1024 } },
        expectedRevision: 1,
      }),
    });
    expect(policyVersion.status).toBe(201);
    expect(asRecord(await policyVersion.json()).version).toBe(2);

    const explicitPolicyUpgrade = await request(
      'access:test-admin',
      '/api/v1/resources/bound-host',
      {
        method: 'PATCH',
        body: JSON.stringify({
          policy: { namespace: 'compute', key: 'standard', version: 2 },
          expectedRevision: 3,
        }),
      },
    );
    expect(explicitPolicyUpgrade.status).toBe(422);

    await env.DB.batch([
      env.DB.prepare(`UPDATE resources SET lifecycle_state = 'retired' WHERE key = 'bound-host'`),
      env.DB.prepare(
        `UPDATE resource_locks SET expires_at = '2000-01-01T00:00:00.000Z'
           WHERE scope = 'resource/bound-host'`,
      ),
    ]);

    const removalOperationRequest = {
      kind: 'remove-provider-binding-and-relationship',
      destructive: true,
      resources: [
        {
          resourceKey: 'bound-host',
          sourceState: 'retired',
          targetState: 'retired',
          resourceRevision: 3,
        },
      ],
      changes: [
        {
          action: 'relationship.remove',
          resourceKey: 'bound-host',
          relationshipId: String(relationshipRecord.id),
        },
        {
          action: 'binding.remove',
          resourceKey: 'bound-host',
        },
      ],
    };
    const provisionerRemoval = await request('access:test-provisioner', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify(removalOperationRequest),
    });
    expect(provisionerRemoval.status).toBe(403);
    expect(asRecord(await provisionerRemoval.json()).error).toMatchObject({ code: 'forbidden' });

    const removalOperationResponse = await request('access:test-operator', '/api/v1/operations', {
      method: 'POST',
      body: JSON.stringify(removalOperationRequest),
    });
    expect(removalOperationResponse.status).toBe(201);
    const removalOperationId = String(asRecord(await removalOperationResponse.json()).id);
    const removalLocks = await request(
      'access:test-operator',
      `/api/v1/operations/${removalOperationId}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/bound-host'], leaseSeconds: 120 }),
      },
    );
    expect(removalLocks.status).toBe(201);
    const removalLockItems = asRecord(await removalLocks.json()).items as Array<JsonRecord>;
    const removalFencingToken = Number(removalLockItems[0]?.fencingToken);
    const startRemoval = await request(
      'access:test-operator',
      `/api/v1/operations/${removalOperationId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 1,
          lockScope: 'resource/bound-host',
          fencingToken: removalFencingToken,
        }),
      },
    );
    expect(startRemoval.status).toBe(200);

    await expect(
      atomicGuardRepository.completeOperation({
        id: removalOperationId,
        expectedRevision: 2,
        lockScope: 'resource/bound-host',
        fencingToken: removalFencingToken,
        actorId: 'actor-operator',
      }),
    ).rejects.toMatchObject({
      code: 'operation_completion_incomplete',
      details: {
        incompleteResources: 0,
        incompleteSteps: 0,
        incompleteChanges: 2,
      },
    });

    const bindingRevisionBeforeStaleRemoval = await env.DB.prepare(
      `SELECT binding_revision FROM providers WHERE id = 'provider-primary'`,
    ).first<{ binding_revision: number }>();
    await expect(
      atomicGuardRepository.removeBinding({
        resourceKey: 'bound-host',
        expectedRevision: 99,
        operationId: removalOperationId,
        fencingToken: removalFencingToken,
        actorId: 'actor-operator',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const bindingRevisionAfterStaleRemoval = await env.DB.prepare(
      `SELECT binding_revision FROM providers WHERE id = 'provider-primary'`,
    ).first<{ binding_revision: number }>();
    expect(bindingRevisionAfterStaleRemoval).toEqual(bindingRevisionBeforeStaleRemoval);

    const staleFenceRemoval = await request(
      'access:test-operator',
      `/api/v1/relationships/${String(relationshipRecord.id)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          expectedRevision: 1,
          operationId: removalOperationId,
          fencingToken: removalFencingToken + 1,
        }),
      },
    );
    expect(staleFenceRemoval.status).toBe(409);

    const staleRevisionRemoval = await request(
      'access:test-operator',
      `/api/v1/relationships/${String(relationshipRecord.id)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          expectedRevision: 99,
          operationId: removalOperationId,
          fencingToken: removalFencingToken,
        }),
      },
    );
    expect(staleRevisionRemoval.status).toBe(409);

    const removeRelationship = await request(
      'access:test-operator',
      `/api/v1/relationships/${String(relationshipRecord.id)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          expectedRevision: 1,
          operationId: removalOperationId,
          fencingToken: removalFencingToken,
        }),
      },
    );
    expect(removeRelationship.status).toBe(204);

    const removeBinding = await request(
      'access:test-operator',
      '/api/v1/resources/bound-host/binding',
      {
        method: 'DELETE',
        body: JSON.stringify({
          expectedRevision: 4,
          operationId: removalOperationId,
          fencingToken: removalFencingToken,
        }),
      },
    );
    expect(removeBinding.status).toBe(204);

    const completeRemoval = await request(
      'access:test-operator',
      `/api/v1/operations/${removalOperationId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 2,
          lockScope: 'resource/bound-host',
          fencingToken: removalFencingToken,
        }),
      },
    );
    expect(completeRemoval.status).toBe(200);
    expect(asRecord(await completeRemoval.json()).status).toBe('succeeded');

    const historyCounts = await env.DB.batch([
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM resource_relationship_history
           WHERE relationship_id = ?`,
      ).bind(String(relationshipRecord.id)),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM provider_binding_history h
           JOIN resources r ON r.id = h.resource_id WHERE r.key = 'bound-host'`,
      ),
    ]);
    const relationshipHistory = historyCounts[0]?.results[0] as { count: number } | undefined;
    const bindingHistory = historyCounts[1]?.results[0] as { count: number } | undefined;
    expect(Number(relationshipHistory?.count)).toBe(1);
    expect(Number(bindingHistory?.count)).toBe(1);

    const retiredProvider = await request(
      'access:test-admin',
      '/api/v1/providers/provider-primary',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'retired', expectedRevision: 2 }),
      },
    );
    expect(retiredProvider.status).toBe(200);
    expect(asRecord(await retiredProvider.json()).status).toBe('retired');
  });

  it('writes a portable, checksummed R2 export from authoritative D1 state', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const requested = await repository.createExport('actor-admin');
    await new R2ExportWriter(repository, exportsBucket()).write(requested.id);

    const completed = await repository.getExport(requested.id);
    expect(completed?.status).toBe('succeeded');
    expect(completed?.checksum).toMatch(/^sha256:/);
    expect(completed?.r2ObjectKey).toBeDefined();

    const object = await exportsBucket().get(completed?.r2ObjectKey ?? 'missing');
    expect(object).not.toBeNull();
    const manifestBody = (await object?.text()) ?? '';
    const manifest = assertPortableExportManifest(JSON.parse(manifestBody || 'null'));
    expect(manifest.checksum).toBe(await checksum(manifestChecksumPayload(manifest)));
    expect(completed?.checksum).toBe(await checksum(manifestBody));
    expect(manifest.chunks.map((chunk) => chunk.entity)).toEqual(PORTABLE_EXPORT_ENTITIES);
    for (const reference of manifest.chunks) {
      const chunkObject = await exportsBucket().get(reference.key);
      expect(chunkObject).not.toBeNull();
      const body = await chunkObject?.text();
      expect(reference.checksum).toBe(await checksum(body ?? ''));
      const chunk = assertPortableExportChunk(JSON.parse(body ?? 'null'));
      expect(chunk).toMatchObject({
        exportId: manifest.exportId,
        entity: reference.entity,
        sequence: reference.sequence,
      });
      expect(chunk.rows).toHaveLength(reference.rows);
    }

    const exportEvents = await env.DB.prepare(
      `SELECT event.event_type
       FROM events event
       JOIN outbox message ON message.event_id = event.event_id
       WHERE json_extract(event.payload_json, '$.exportId') = ?
       ORDER BY event.occurred_at`,
    )
      .bind(requested.id)
      .all<{ event_type: string }>();
    expect(exportEvents.results.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['export.requested', 'export.running', 'export.succeeded']),
    );
    expect(exportEvents.results).toHaveLength(3);
  });

  it('bounds resource detail collections and rejects drift-retention amplification', async () => {
    const resource = { id: 'amplified-parent' };
    const statements: D1PreparedStatement[] = [];
    statements.push(
      env.DB.prepare(
        `INSERT INTO resources (
          id, key, kind, name, placement_json, spec_overrides_json, effective_spec_json,
          lifecycle_state, revision, created_at, updated_at
        ) VALUES (?, 'amplified-parent', 'location', 'Amplified Parent', '{}', '{}', '{"category":"site"}', 'absent', 1, ?, ?)`,
      ).bind(resource.id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    );
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const targetId = `amplified-target-${suffix}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO resources (
            id, key, kind, name, placement_json, spec_overrides_json, effective_spec_json,
            lifecycle_state, revision, created_at, updated_at
          ) VALUES (?, ?, 'network', ?, '{}', '{}', '{"addressFamily":"ipv4","cidrs":["10.0.0.0/24"]}', 'absent', 1, ?, ?)`,
        ).bind(
          targetId,
          `amplified-target-${suffix}`,
          `Amplified Target ${suffix}`,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
        ),
        env.DB.prepare(
          `INSERT INTO resource_relationships (
            id, source_resource_id, target_resource_id, relationship_type,
            revision, created_at, created_by
          ) VALUES (?, ?, ?, 'uses_network', 1, ?, 'actor-admin')`,
        ).bind(
          `amplified-relationship-${suffix}`,
          resource.id,
          targetId,
          '2026-08-01T00:00:00.000Z',
        ),
      );
    }
    for (let index = 0; index < 501; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const fingerprint = `sha256:${index.toString(16).padStart(64, '0')}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO drifts (
            id, resource_id, severity, status, fingerprint, expected_json, observed_json,
            revision, created_at, updated_at, created_by, resolved_at
          ) VALUES (?, ?, 'low', 'resolved', ?, ?, ?, 1, ?, ?, 'actor-observer', ?)`,
        ).bind(
          `amplified-drift-${suffix}`,
          resource.id,
          fingerprint,
          JSON.stringify({ index }),
          JSON.stringify({ index: index + 1 }),
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
        ),
      );
    }
    for (let index = 0; index < statements.length; index += 100) {
      await env.DB.batch(statements.slice(index, index + 100));
    }

    const firstPage = await request(
      'access:test-admin',
      '/api/v1/resources/amplified-parent?relationshipLimit=10&driftLimit=10',
    );
    expect(firstPage.status).toBe(200);
    const firstDetail = asRecord(await firstPage.json());
    expect(firstDetail.relationships).toHaveLength(10);
    expect(firstDetail.drifts).toHaveLength(10);
    expect(firstDetail.relationshipsNextCursor).toBe('amplified-relationship-009');
    expect(firstDetail.driftsNextCursor).toBe('amplified-drift-009');

    const secondPage = await request(
      'access:test-admin',
      `/api/v1/resources/amplified-parent?relationshipLimit=10&driftLimit=10&relationshipCursor=${firstDetail.relationshipsNextCursor}&driftCursor=${firstDetail.driftsNextCursor}`,
    );
    expect(secondPage.status).toBe(200);
    const secondDetail = asRecord(await secondPage.json());
    expect(secondDetail.relationships).toHaveLength(10);
    expect(secondDetail.drifts).toHaveLength(10);
    expect(asRecord((secondDetail.relationships as unknown[])[0]).id).toBe(
      'amplified-relationship-010',
    );
    expect(asRecord((secondDetail.drifts as unknown[])[0]).id).toBe('amplified-drift-010');

    const overQuota = await request('access:test-observer', '/api/v1/drifts', {
      method: 'POST',
      body: JSON.stringify({
        resourceKey: 'amplified-parent',
        severity: 'low',
        expected: { new: true },
        observed: { new: false },
      }),
    });
    expect(overQuota.status).toBe(409);
    expect(asRecord(await overQuota.json()).error).toMatchObject({
      code: 'drift_quota_exceeded',
    });
  });

  it('archives expired observations to R2 and records the archival pointer', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const observation = await repository.createObservation({
      resourceKey: 'web-01',
      observedAt: new Date().toISOString(),
      facts: { provider: { power: 'running' } },
      retentionHours: 1,
      actorId: 'actor-observer',
    });

    const archived = await new R2ObservationArchiver(repository, exportsBucket()).archiveExpired(
      'actor-admin',
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    expect(archived).toBe(1);

    const row = await env.DB.prepare(
      'SELECT archived_at, r2_object_key FROM observations WHERE id = ?',
    )
      .bind(observation.id)
      .first<{ archived_at: string | null; r2_object_key: string | null }>();
    expect(row?.archived_at).not.toBeNull();
    expect(row?.r2_object_key).toBeDefined();

    const object = await exportsBucket().get(row?.r2_object_key ?? 'missing');
    expect(object).not.toBeNull();
    expect(await object?.json()).toMatchObject({
      observation: {
        id: observation.id,
        resourceKey: 'web-01',
        facts: { provider: { power: 'running' } },
      },
    });
    expect(
      (await repository.listResourceEvents('web-01')).map((event) => event.eventType),
    ).toContain('observation.archived');
  });
});
