import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails } from '../errors/violations';
import type { RelationshipType, ResourceKindDefinitionVersion } from '../models/global-registry';

export function validateRelationshipKinds(
  sourceDefinition: ResourceKindDefinitionVersion,
  type: RelationshipType,
  targetKind: string,
): void {
  const rule = sourceDefinition.relationshipRules.find(
    (candidate) => candidate.relationshipType === type,
  );
  if (rule?.targetKinds.some((candidate) => candidate === '*' || candidate === targetKind)) return;

  throw new ValidationError(
    'invalid_relationship_kinds',
    'The relationship is not allowed by the source Resource kind definition.',
    violationsDetails([
      {
        code: 'invalid_relationship_kinds',
        path: 'relationshipType',
        message: `${sourceDefinition.key}@${sourceDefinition.version} does not allow ${type} to ${targetKind}.`,
      },
    ]),
  );
}
