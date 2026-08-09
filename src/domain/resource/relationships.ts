import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails } from '../errors/violations';
import type { RelationshipType, ResourceKind } from '../models/global-registry';

interface RelationshipRule {
  source: ResourceKind;
  type: RelationshipType;
  target: ResourceKind;
}

const RELATIONSHIP_RULES: readonly RelationshipRule[] = [
  { source: 'service_instance', type: 'member_of', target: 'service_cluster' },
  { source: 'service_instance', type: 'hosted_on', target: 'compute' },
  { source: 'compute', type: 'uses_network', target: 'network' },
  { source: 'compute', type: 'uses_volume', target: 'volume' },
  { source: 'service_instance', type: 'exposes_endpoint', target: 'endpoint' },
  { source: 'compute', type: 'backed_up_to', target: 'backup_repository' },
];

export function validateRelationshipKinds(
  source: ResourceKind,
  type: RelationshipType,
  target: ResourceKind,
): void {
  const fixedRule = RELATIONSHIP_RULES.some(
    (rule) => rule.source === source && rule.type === type && rule.target === target,
  );
  const sameKindRule = (type === 'depends_on' || type === 'replacement_for') && source === target;
  if (fixedRule || sameKindRule) return;

  throw new ValidationError(
    'invalid_relationship_kinds',
    'The relationship is not allowed for these resource kinds.',
    violationsDetails([
      {
        code: 'invalid_relationship_kinds',
        path: 'relationshipType',
        message: `${source} ${type} ${target} is not an allowed relationship.`,
      },
    ]),
  );
}
