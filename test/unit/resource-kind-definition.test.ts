import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors/global-registry-error';
import { STANDARD_RESOURCE_KINDS } from '../../src/domain/models/global-registry';
import { standardResourceKindDefinition } from '../../src/domain/resource-kind/standard';
import { validateResourceKindDefinition } from '../../src/domain/resource-kind/validation';

const validExtension = {
  key: 'example.internal-appliance',
  states: ['absent', 'ready', 'retired'],
  initialState: 'absent',
  terminalStates: ['retired'],
  transitions: [
    { from: 'absent', to: 'ready', destructive: false },
    { from: 'ready', to: 'retired', destructive: true },
  ],
  placementMode: 'located',
  relationshipRules: [
    { relationshipType: 'depends_on', targetKinds: ['example.internal-appliance'] },
  ],
} as const;

describe('Resource kind definition validation', () => {
  it('keeps every seeded standard definition internally valid', () => {
    for (const key of STANDARD_RESOURCE_KINDS) {
      const definition = standardResourceKindDefinition(key);
      expect(
        validateResourceKindDefinition({
          key: definition.key,
          states: definition.states,
          initialState: definition.initialState,
          terminalStates: definition.terminalStates,
          transitions: definition.transitions,
          placementMode: definition.placementMode,
          relationshipRules: definition.relationshipRules,
        }).specificationMode,
      ).toBe('standard');
    }
  });

  it('infers opaque specification validation for extension kinds', () => {
    expect(validateResourceKindDefinition(validExtension)).toMatchObject({
      key: validExtension.key,
      specificationMode: 'opaque',
    });
  });

  it('rejects lifecycle states that are unreachable from the initial state', () => {
    expect(() =>
      validateResourceKindDefinition({
        ...validExtension,
        states: ['absent', 'ready', 'orphaned', 'retired'],
        transitions: [
          ...validExtension.transitions,
          { from: 'orphaned', to: 'retired', destructive: true },
        ],
      }),
    ).toThrowError(ValidationError);
  });

  it('rejects lifecycle states that cannot reach a terminal state', () => {
    expect(() =>
      validateResourceKindDefinition({
        ...validExtension,
        states: ['absent', 'ready', 'looping', 'stuck', 'retired'],
        transitions: [
          { from: 'absent', to: 'ready', destructive: false },
          { from: 'absent', to: 'looping', destructive: false },
          { from: 'ready', to: 'retired', destructive: true },
          { from: 'looping', to: 'stuck', destructive: false },
          { from: 'stuck', to: 'looping', destructive: false },
        ],
      }),
    ).toThrowError(ValidationError);
  });

  it('rejects ambiguous wildcard relationship targets', () => {
    expect(() =>
      validateResourceKindDefinition({
        ...validExtension,
        relationshipRules: [
          {
            relationshipType: 'depends_on',
            targetKinds: ['*', 'example.internal-appliance'],
          },
        ],
      }),
    ).toThrowError(ValidationError);
  });
});
