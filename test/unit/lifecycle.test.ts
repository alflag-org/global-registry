import { describe, expect, it } from 'vitest';
import {
  isDestructiveLifecycleTransition,
  validateLifecycleTransition,
} from '../../src/domain/lifecycle/lifecycle';
import { ValidationError } from '../../src/domain/errors/global-registry-error';

describe('lifecycle transition rules', () => {
  it('allows only the defined compute path', () => {
    expect(() => validateLifecycleTransition('compute', 'absent', 'allocated')).not.toThrow();
    expect(() => validateLifecycleTransition('compute', 'ready', 'stopped')).not.toThrow();
    expect(() => validateLifecycleTransition('compute', 'serving', 'stopped')).toThrow(
      ValidationError,
    );
  });

  it('keeps service traffic drainage explicit', () => {
    expect(() => validateLifecycleTransition('service_instance', 'serving', 'offline')).toThrow(
      ValidationError,
    );
    expect(() =>
      validateLifecycleTransition('service_instance', 'serving', 'draining'),
    ).not.toThrow();
  });

  it('marks retirement as a destructive operation', () => {
    expect(isDestructiveLifecycleTransition('retired')).toBe(true);
    expect(isDestructiveLifecycleTransition('ready')).toBe(false);
  });
});
