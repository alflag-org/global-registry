import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import {
  STANDARD_RESOURCE_KINDS,
  type ResourceKindDefinitionVersion,
  type ResourceSpecificationMode,
} from '../models/global-registry';
import { resourceKindDefinitionInputSchema, type ResourceKindDefinitionInput } from './schemas';

export interface ValidatedResourceKindDefinition extends ResourceKindDefinitionInput {
  specificationMode: ResourceSpecificationMode;
}

export function validateResourceKindDefinition(value: unknown): ValidatedResourceKindDefinition {
  const result = resourceKindDefinitionInputSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_resource_kind_definition',
      'Resource kind definition is invalid.',
      violationsDetails(zodViolations(result.error)),
    );
  }

  const definition = result.data;
  const states = new Set(definition.states);
  if (!states.has(definition.initialState)) {
    throw definitionError('initialState', 'The initial state must appear in states.');
  }
  for (const terminalState of definition.terminalStates) {
    if (!states.has(terminalState)) {
      throw definitionError(
        'terminalStates',
        `Terminal state ${terminalState} must appear in states.`,
      );
    }
  }
  if (definition.terminalStates.includes(definition.initialState) && definition.states.length > 1) {
    throw definitionError(
      'initialState',
      'The initial state cannot be terminal when the definition has other states.',
    );
  }

  const transitionKeys = new Set<string>();
  for (const transition of definition.transitions) {
    if (!states.has(transition.from) || !states.has(transition.to)) {
      throw definitionError(
        'transitions',
        `Transition ${transition.from} -> ${transition.to} must use declared states.`,
      );
    }
    if (transition.from === transition.to) {
      throw definitionError('transitions', 'Lifecycle transitions cannot target the same state.');
    }
    if (definition.terminalStates.includes(transition.from)) {
      throw definitionError(
        'transitions',
        `Terminal state ${transition.from} cannot have outgoing transitions.`,
      );
    }
    const key = `${transition.from}\u0000${transition.to}`;
    if (transitionKeys.has(key)) {
      throw definitionError(
        'transitions',
        `Transition ${transition.from} -> ${transition.to} is duplicated.`,
      );
    }
    transitionKeys.add(key);
  }

  const statesWithOutgoingEdges = new Set(definition.transitions.map(({ from }) => from));
  for (const state of definition.states) {
    if (!definition.terminalStates.includes(state) && !statesWithOutgoingEdges.has(state)) {
      throw definitionError(
        'transitions',
        `Non-terminal state ${state} must have at least one outgoing transition.`,
      );
    }
  }

  const reachableFromInitial = reachableStates(
    [definition.initialState],
    definition.transitions.map(({ from, to }) => [from, to] as const),
  );
  for (const state of definition.states) {
    if (!reachableFromInitial.has(state)) {
      throw definitionError(
        'states',
        `Lifecycle state ${state} is not reachable from ${definition.initialState}.`,
      );
    }
  }

  const canReachTerminal = reachableStates(
    definition.terminalStates,
    definition.transitions.map(({ from, to }) => [to, from] as const),
  );
  for (const state of definition.states) {
    if (!canReachTerminal.has(state)) {
      throw definitionError(
        'transitions',
        `Lifecycle state ${state} cannot reach a terminal state.`,
      );
    }
  }

  const relationshipTypes = new Set<string>();
  for (const rule of definition.relationshipRules) {
    if (relationshipTypes.has(rule.relationshipType)) {
      throw definitionError(
        'relationshipRules',
        `Relationship type ${rule.relationshipType} is duplicated.`,
      );
    }
    relationshipTypes.add(rule.relationshipType);
    if (rule.targetKinds.includes('*') && rule.targetKinds.length > 1) {
      throw definitionError(
        'relationshipRules',
        'A wildcard target kind must be the only target in its rule.',
      );
    }
  }

  return {
    ...definition,
    specificationMode: isStandardResourceKind(definition.key) ? 'standard' : 'opaque',
  };
}

export function assertResourceKindDefinitionVersion(
  definition: ResourceKindDefinitionVersion,
): void {
  const validated = validateResourceKindDefinition({
    key: definition.key,
    states: definition.states,
    initialState: definition.initialState,
    terminalStates: definition.terminalStates,
    transitions: definition.transitions,
    placementMode: definition.placementMode,
    relationshipRules: definition.relationshipRules,
  });
  if (validated.specificationMode !== definition.specificationMode) {
    throw definitionError(
      'specificationMode',
      `Definition ${definition.key} must use ${validated.specificationMode} specification validation.`,
    );
  }
}

export function isStandardResourceKind(
  key: string,
): key is (typeof STANDARD_RESOURCE_KINDS)[number] {
  return (STANDARD_RESOURCE_KINDS as readonly string[]).includes(key);
}

function definitionError(path: string, message: string): ValidationError {
  return new ValidationError(
    'invalid_resource_kind_definition',
    'Resource kind definition is invalid.',
    violationsDetails([
      {
        code: 'invalid_resource_kind_definition',
        path,
        message,
      },
    ]),
  );
}

function reachableStates(
  initial: readonly string[],
  edges: readonly (readonly [string, string])[],
): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const targets = adjacent.get(from) ?? [];
    targets.push(to);
    adjacent.set(from, targets);
  }
  const visited = new Set(initial);
  const pending = [...initial];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const target of adjacent.get(current) ?? []) {
      if (visited.has(target)) continue;
      visited.add(target);
      pending.push(target);
    }
  }
  return visited;
}
