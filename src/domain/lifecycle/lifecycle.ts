import { ValidationError } from '../errors/global-registry-error';
import type { ResourceKind, ResourceLifecycleState } from '../models/global-registry';

type LifecycleTransitions = Readonly<
  Partial<Record<ResourceLifecycleState, readonly ResourceLifecycleState[]>>
>;

const COMPUTE_TRANSITIONS = {
  absent: ['allocated'],
  allocated: ['bootstrapped'],
  bootstrapped: ['configured'],
  configured: ['ready'],
  ready: ['stopped'],
  stopped: ['ready', 'retired'],
  retired: [],
} satisfies LifecycleTransitions;

const SERVICE_TRANSITIONS = {
  absent: ['configured'],
  configured: ['initialized'],
  initialized: ['integrated'],
  integrated: ['ready'],
  ready: ['serving'],
  serving: ['draining'],
  draining: ['offline'],
  offline: ['ready', 'stopped'],
  stopped: ['ready', 'retired'],
  retired: [],
} satisfies LifecycleTransitions;

const ENDPOINT_TRANSITIONS = {
  absent: ['configured'],
  configured: ['ready'],
  ready: ['serving'],
  serving: ['offline'],
  offline: ['ready', 'retired'],
  retired: [],
} satisfies LifecycleTransitions;

const GENERIC_TRANSITIONS = {
  absent: ['ready'],
  ready: ['retired'],
  retired: [],
} satisfies LifecycleTransitions;

export function lifecycleTransitions(kind: ResourceKind): LifecycleTransitions {
  if (kind === 'compute') return COMPUTE_TRANSITIONS;
  if (kind === 'service_instance' || kind === 'service_cluster') return SERVICE_TRANSITIONS;
  if (kind === 'endpoint') return ENDPOINT_TRANSITIONS;
  return GENERIC_TRANSITIONS;
}

export function validateLifecycleTransition(
  kind: ResourceKind,
  from: ResourceLifecycleState,
  to: ResourceLifecycleState,
): void {
  const permitted = lifecycleTransitions(kind)[from];
  if (!permitted?.includes(to)) {
    throw new ValidationError(
      'invalid_lifecycle_transition',
      'Lifecycle transition is not permitted.',
      {
        kind,
        from,
        to,
      },
    );
  }
}

export function isDestructiveLifecycleTransition(to: ResourceLifecycleState): boolean {
  return to === 'retired';
}
