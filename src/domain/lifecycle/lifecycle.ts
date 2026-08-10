import { ValidationError } from '../errors/global-registry-error';
import type {
  ResourceKindDefinitionVersion,
  ResourceLifecycleState,
  ResourceLifecycleTransition,
} from '../models/global-registry';

export function lifecycleTransitions(
  definition: ResourceKindDefinitionVersion,
  from: ResourceLifecycleState,
): readonly ResourceLifecycleTransition[] {
  return definition.transitions.filter((transition) => transition.from === from);
}

export function validateLifecycleTransition(
  definition: ResourceKindDefinitionVersion,
  from: ResourceLifecycleState,
  to: ResourceLifecycleState,
): ResourceLifecycleTransition {
  const transition = definition.transitions.find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (transition === undefined) {
    throw new ValidationError(
      'invalid_lifecycle_transition',
      'Lifecycle transition is not permitted.',
      { kind: definition.key, kindVersion: definition.version, from, to },
    );
  }
  return transition;
}

export function isDestructiveLifecycleTransition(
  definition: ResourceKindDefinitionVersion,
  from: ResourceLifecycleState,
  to: ResourceLifecycleState,
): boolean {
  return validateLifecycleTransition(definition, from, to).destructive;
}

export function isTerminalLifecycleState(
  definition: ResourceKindDefinitionVersion,
  state: ResourceLifecycleState,
): boolean {
  return definition.terminalStates.includes(state);
}
