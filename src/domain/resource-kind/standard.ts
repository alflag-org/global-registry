import type {
  ResourceKindDefinitionVersion,
  ResourceKindRelationshipRule,
  ResourceLifecycleTransition,
  StandardResourceKind,
} from '../models/global-registry';

type SeedDefinition = Omit<
  ResourceKindDefinitionVersion,
  'version' | 'parentStatus' | 'revision' | 'createdAt'
>;

const genericTransitions = transitions({
  absent: ['ready'],
  ready: ['retired'],
});

const computeTransitions = transitions({
  absent: ['allocated'],
  allocated: ['bootstrapped'],
  bootstrapped: ['configured'],
  configured: ['ready'],
  ready: ['stopped'],
  stopped: ['ready', 'retired'],
});

const serviceTransitions = transitions({
  absent: ['configured'],
  configured: ['initialized'],
  initialized: ['integrated'],
  integrated: ['ready'],
  ready: ['serving'],
  serving: ['draining'],
  draining: ['offline'],
  offline: ['ready', 'stopped'],
  stopped: ['ready', 'retired'],
});

const endpointTransitions = transitions({
  absent: ['configured'],
  configured: ['ready'],
  ready: ['serving'],
  serving: ['offline'],
  offline: ['ready', 'retired'],
});

const sameKindRules = (kind: StandardResourceKind): ResourceKindRelationshipRule[] => [
  { relationshipType: 'depends_on', targetKinds: [kind] },
  { relationshipType: 'replacement_for', targetKinds: [kind] },
];

export const STANDARD_RESOURCE_KIND_DEFINITIONS: Readonly<
  Record<StandardResourceKind, SeedDefinition>
> = {
  location: standardDefinition('location', ['absent', 'ready', 'retired'], genericTransitions),
  network: standardDefinition('network', ['absent', 'ready', 'retired'], genericTransitions),
  compute: standardDefinition(
    'compute',
    ['absent', 'allocated', 'bootstrapped', 'configured', 'ready', 'stopped', 'retired'],
    computeTransitions,
    [
      { relationshipType: 'uses_network', targetKinds: ['network'] },
      { relationshipType: 'uses_volume', targetKinds: ['volume'] },
      { relationshipType: 'backed_up_to', targetKinds: ['backup_repository'] },
    ],
  ),
  volume: standardDefinition('volume', ['absent', 'ready', 'retired'], genericTransitions),
  service_cluster: standardDefinition(
    'service_cluster',
    [
      'absent',
      'configured',
      'initialized',
      'integrated',
      'ready',
      'serving',
      'draining',
      'offline',
      'stopped',
      'retired',
    ],
    serviceTransitions,
  ),
  service_instance: standardDefinition(
    'service_instance',
    [
      'absent',
      'configured',
      'initialized',
      'integrated',
      'ready',
      'serving',
      'draining',
      'offline',
      'stopped',
      'retired',
    ],
    serviceTransitions,
    [
      { relationshipType: 'member_of', targetKinds: ['service_cluster'] },
      { relationshipType: 'hosted_on', targetKinds: ['compute'] },
      { relationshipType: 'exposes_endpoint', targetKinds: ['endpoint'] },
    ],
  ),
  endpoint: standardDefinition(
    'endpoint',
    ['absent', 'configured', 'ready', 'serving', 'offline', 'retired'],
    endpointTransitions,
  ),
  backup_repository: standardDefinition(
    'backup_repository',
    ['absent', 'ready', 'retired'],
    genericTransitions,
  ),
};

export function standardResourceKindDefinition(
  key: StandardResourceKind,
): ResourceKindDefinitionVersion {
  return {
    ...STANDARD_RESOURCE_KIND_DEFINITIONS[key],
    version: 1,
    parentStatus: 'active',
    revision: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
  };
}

function standardDefinition(
  key: StandardResourceKind,
  states: string[],
  lifecycleTransitions: ResourceLifecycleTransition[],
  rules: ResourceKindRelationshipRule[] = [],
): SeedDefinition {
  return {
    key,
    states,
    initialState: 'absent',
    terminalStates: ['retired'],
    transitions: lifecycleTransitions,
    placementMode: key === 'location' ? 'root' : 'located',
    specificationMode: 'standard',
    relationshipRules: [...rules, ...sameKindRules(key)],
  };
}

function transitions(graph: Record<string, string[]>): ResourceLifecycleTransition[] {
  return Object.entries(graph).flatMap(([from, targets]) =>
    targets.map((to) => ({ from, to, destructive: to === 'retired' })),
  );
}
