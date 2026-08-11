import { describe, expect, it } from 'vitest';
import {
  bootstrapAdminUsage,
  buildBootstrapAdminSql,
  parseBootstrapAdminArguments,
  parseBootstrapAdminOutput,
} from '../../scripts/bootstrap-admin-core';

describe('bootstrap-admin CLI', () => {
  it('defaults to the contained local D1 configuration', () => {
    expect(
      parseBootstrapAdminArguments([
        '--database',
        'DB',
        '--identity',
        'access:first-admin',
        '--display-name',
        '  Registry Administrator  ',
      ]),
    ).toEqual({
      database: 'DB',
      identity: 'access:first-admin',
      displayName: 'Registry Administrator',
      remote: false,
      config: 'wrangler.jsonc',
      environment: 'development',
    });
  });

  it('requires an explicit remote mode and generated config', () => {
    expect(
      parseBootstrapAdminArguments([
        '--remote',
        '--config',
        'generated-wrangler.json',
        '--database',
        'registry-production',
        '--identity',
        'service:bootstrap-admin',
        '--display-name',
        'Bootstrap Administrator',
      ]),
    ).toEqual({
      database: 'registry-production',
      identity: 'service:bootstrap-admin',
      displayName: 'Bootstrap Administrator',
      remote: true,
      config: 'generated-wrangler.json',
    });
  });

  it('accepts a canonical fixed actor ID for manifest-aligned bootstrap', () => {
    expect(
      parseBootstrapAdminArguments([
        '--database',
        'DB',
        '--identity',
        'access:first-admin',
        '--display-name',
        'Registry Administrator',
        '--actor-id',
        '00000000-0000-4000-8000-000000000001',
      ]),
    ).toMatchObject({ actorId: '00000000-0000-4000-8000-000000000001' });
    expect(() =>
      parseBootstrapAdminArguments([
        '--database',
        'DB',
        '--identity',
        'access:first-admin',
        '--display-name',
        'Registry Administrator',
        '--actor-id',
        'not-a-uuid',
      ]),
    ).toThrow('canonical lowercase UUID v4');
  });

  it('rejects ambiguous modes, unsafe paths, and non-canonical identities', () => {
    expect(() =>
      parseBootstrapAdminArguments([
        '--local',
        '--remote',
        '--database',
        'DB',
        '--identity',
        'access:admin',
        '--display-name',
        'Admin',
      ]),
    ).toThrow('--local and --remote');
    expect(() =>
      parseBootstrapAdminArguments([
        '--database',
        'DB',
        '--identity',
        'email@example.com',
        '--display-name',
        'Admin',
      ]),
    ).toThrow('Invalid admin Actor');
    expect(() =>
      parseBootstrapAdminArguments([
        '--database',
        'DB',
        '--identity',
        'access:admin',
        '--display-name',
        'Admin',
        '--config',
        '../outside.jsonc',
      ]),
    ).toThrow('contained relative path');
  });

  it('builds a conditional self-owned insert without embedding operator text', () => {
    const sql = buildBootstrapAdminSql({
      actorId: 'actor-bootstrap',
      identity: "service:operator'one",
      displayName: "Admin'); DROP TABLE actors; --",
      createdAt: '2026-08-10T00:00:00.000Z',
    });

    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM actors WHERE role = 'admin')");
    expect(sql).toContain("'admin', 1, 1");
    expect(sql).toContain('SELECT changes() AS bootstrap_inserted');
    expect(sql).toContain('audit_events');
    expect(sql).toContain('outbox_rows');
    expect(sql).not.toContain("service:operator'one");
    expect(sql).not.toContain('DROP TABLE actors');
  });

  it('accepts only one verified admin insert result', () => {
    const output = JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ bootstrap_inserted: 1 }] },
      {
        success: true,
        results: [
          {
            actor_id: 'actor-bootstrap',
            identity: 'access:first-admin',
            role: 'admin',
            active: 1,
            audit_events: 1,
            outbox_rows: 1,
          },
        ],
      },
    ]);
    expect(parseBootstrapAdminOutput(output)).toEqual({
      actorId: 'actor-bootstrap',
      identity: 'access:first-admin',
      auditEvents: 1,
      outboxRows: 1,
    });

    expect(() =>
      parseBootstrapAdminOutput(
        JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ bootstrap_inserted: 0 }] },
          { success: true, results: [] },
        ]),
      ),
    ).toThrow('already exists');
  });

  it('provides task-oriented help without an HTTP bootstrap path', () => {
    expect(parseBootstrapAdminArguments(['--help'])).toBeNull();
    expect(bootstrapAdminUsage()).toContain('mise run bootstrap-admin');
    expect(bootstrapAdminUsage()).toContain('--remote');
    expect(bootstrapAdminUsage()).not.toContain('/api/');
  });
});
