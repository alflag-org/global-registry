import type { JsonObject, ResourceKind } from '../models/global-registry';

export interface PolicyDefinition {
  namespace: string;
  key: string;
  resourceKind: ResourceKind;
  resourceKindVersion: number;
  spec: JsonObject;
}

export interface PolicyVersionDefinition extends PolicyDefinition {
  version: number;
}
