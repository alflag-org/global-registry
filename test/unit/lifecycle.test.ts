import { describe, expect, it } from 'vitest';
import {
  isDestructiveLifecycleTransition,
  validateLifecycleTransition,
} from '../../src/domain/lifecycle/lifecycle';
import { ValidationError } from '../../src/domain/errors/global-registry-error';
import { standardResourceKindDefinition } from '../../src/domain/resource-kind/standard';

describe('lifecycle transition rules', () => {
  it('allows only the defined compute path', () => {
    const definition = standardResourceKindDefinition('compute');
    expect(() => validateLifecycleTransition(definition, 'absent', 'allocated')).not.toThrow();
    expect(() => validateLifecycleTransition(definition, 'ready', 'stopped')).not.toThrow();
    expect(() => validateLifecycleTransition(definition, 'serving', 'stopped')).toThrow(
      ValidationError,
    );
  });

  it('keeps service traffic drainage explicit', () => {
    const definition = standardResourceKindDefinition('service_instance');
    expect(() => validateLifecycleTransition(definition, 'serving', 'offline')).toThrow(
      ValidationError,
    );
    expect(() => validateLifecycleTransition(definition, 'serving', 'draining')).not.toThrow();
  });

  it('marks retirement as a destructive operation', () => {
    const definition = standardResourceKindDefinition('compute');
    expect(isDestructiveLifecycleTransition(definition, 'stopped', 'retired')).toBe(true);
    expect(isDestructiveLifecycleTransition(definition, 'stopped', 'ready')).toBe(false);
  });
});
