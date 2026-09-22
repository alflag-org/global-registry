import { describe, it, expect } from 'vitest';
import { dependencyReport } from '../scripts/dependency-report';
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const report = (advisories: Record<string, unknown> = {}) =>
  JSON.stringify({
    advisories,
    metadata: { vulnerabilities: { ...counts, high: Object.keys(advisories).length } },
  });
describe('scheduled dependency reporting', () => {
  it('reports findings without turning them into build failures', () => {
    const summary = dependencyReport(
      report({
        '1': {
          module_name: 'example',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        },
      }),
      1,
    );
    expect(summary).toContain('high: 1');
    expect(summary).toContain('example');
    expect(summary).toContain('[Details]');
  });
  it('reports a completed clean scan', () =>
    expect(dependencyReport(report(), 0)).toContain('high: 0'));
  it.each([
    ['{}', 1],
    ['not json', 0],
    [report(), 1],
    [report(), 2],
    [report(), null],
    [JSON.stringify({ error: { code: 'REGISTRY_UNAVAILABLE' } }), 1],
  ])('rejects incomplete or failed scans', (output, status) =>
    expect(() => dependencyReport(String(output), status as number | null)).toThrow(),
  );
});
