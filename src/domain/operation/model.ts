import type { RelationshipType } from '../models/global-registry';

export type OperationChange =
  | {
      action: 'binding.replace';
      resourceKey: string;
      providerId: string;
      providerResourceType: string;
      providerResourceId: string;
    }
  | {
      action: 'binding.remove';
      resourceKey: string;
    }
  | {
      action: 'relationship.create';
      resourceKey: string;
      targetResourceKey: string;
      relationshipType: RelationshipType;
    }
  | {
      action: 'relationship.remove';
      resourceKey: string;
      relationshipId: string;
    };
