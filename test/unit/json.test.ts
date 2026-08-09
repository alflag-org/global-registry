import { describe, expect, it } from 'vitest';
import {
  assertJsonValueLimits,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  mergeJsonObjects,
} from '../../src/domain/models/json';
import {
  assertOperationLimits,
  MAX_OPERATION_CHANGES,
  MAX_OPERATION_RESOURCES,
  MAX_OPERATION_STEPS,
  MAX_OPERATION_WORK_BYTES,
} from '../../src/domain/operation/limits';

describe('JSON object merging', () => {
  it('materializes nested profile defaults without mutating either input', () => {
    const defaults = {
      compute: { architecture: 'amd64', vcpu: 2, memoryMib: 4096 },
      network: { exposure: 'private' },
      labels: ['profile-default'],
    };
    const overrides = {
      compute: { memoryMib: 8192 },
      labels: ['resource-specific'],
    };

    expect(mergeJsonObjects(defaults, overrides)).toEqual({
      compute: { architecture: 'amd64', vcpu: 2, memoryMib: 8192 },
      network: { exposure: 'private' },
      labels: ['resource-specific'],
    });
    expect(defaults).toEqual({
      compute: { architecture: 'amd64', vcpu: 2, memoryMib: 4096 },
      network: { exposure: 'private' },
      labels: ['profile-default'],
    });
    expect(overrides).toEqual({
      compute: { memoryMib: 8192 },
      labels: ['resource-specific'],
    });
  });

  const overLimitCases: Array<{
    label: string;
    code: string;
    resources: number;
    changes: number;
    steps: number;
  }> = [
    {
      label: 'resources',
      code: 'operation_resources_limit',
      resources: MAX_OPERATION_RESOURCES + 1,
      changes: 0,
      steps: 0,
    },
    {
      label: 'steps',
      code: 'operation_steps_limit',
      resources: 1,
      changes: 0,
      steps: MAX_OPERATION_STEPS + 1,
    },
    {
      label: 'changes',
      code: 'operation_changes_limit',
      resources: 1,
      changes: MAX_OPERATION_CHANGES + 1,
      steps: 0,
    },
  ];

  it.each(overLimitCases)(
    'rejects an over-limit $label array',
    ({ code, resources, changes, steps }) => {
      expect(() =>
        assertOperationLimits({
          intent: {},
          resources: Array.from({ length: resources }, () => ({})),
          changes: Array.from({ length: changes }, () => ({})),
          steps: Array.from({ length: steps }, () => ({})),
        }),
      ).toThrow(expect.objectContaining({ code }));
    },
  );

  it('accepts operation arrays exactly at their individual limits', () => {
    expect(() =>
      assertOperationLimits({
        intent: {},
        resources: Array.from({ length: MAX_OPERATION_RESOURCES }, () => ({})),
        changes: Array.from({ length: MAX_OPERATION_CHANGES }, () => ({})),
        steps: Array.from({ length: MAX_OPERATION_STEPS }, () => ({})),
      }),
    ).not.toThrow();
  });

  it('rejects an operation whose aggregate JSON work exceeds the D1 budget', () => {
    expect(() =>
      assertOperationLimits({
        intent: { padding: 'x'.repeat(MAX_OPERATION_WORK_BYTES) },
        resources: [{}],
        changes: [],
        steps: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_work_limit' }));
  });
});

describe('JSON graph limits', () => {
  function nestedObject(depth: number): Record<string, unknown> {
    let value: unknown = { leaf: true };
    for (let index = 0; index < depth; index += 1) value = { next: value };
    return value as Record<string, unknown>;
  }

  it('accepts the explicit depth and node-count boundaries', () => {
    expect(() => assertJsonValueLimits(nestedObject(MAX_JSON_DEPTH - 1), 'boundary')).not.toThrow();
    expect(() =>
      assertJsonValueLimits(
        { values: Array.from({ length: MAX_JSON_NODES - 2 }, () => null) },
        'boundary',
      ),
    ).not.toThrow();
  });

  it('rejects depth and node-count overflow before recursive normalization', () => {
    expect(() => assertJsonValueLimits(nestedObject(MAX_JSON_DEPTH), 'too-deep')).toThrow(
      expect.objectContaining({ code: 'json_limits_exceeded' }),
    );
    expect(() =>
      assertJsonValueLimits(
        { values: Array.from({ length: MAX_JSON_NODES - 1 }, () => null) },
        'too-many-nodes',
      ),
    ).toThrow(expect.objectContaining({ code: 'json_limits_exceeded' }));
  });

  it('rejects a roughly 30 KiB depth-5000 reproducer without a stack overflow', () => {
    const serialized = `${'{"next":'.repeat(5_000)}null${'}'.repeat(5_000)}`;
    const parsed: unknown = JSON.parse(serialized);

    expect(serialized.length).toBeGreaterThan(30_000);
    expect(() => assertJsonValueLimits(parsed, 'deep-input')).toThrow(
      expect.objectContaining({ code: 'json_limits_exceeded' }),
    );
  });
});
