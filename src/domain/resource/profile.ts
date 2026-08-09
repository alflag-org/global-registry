import { mergeJsonObjects } from '../models/json';
import type { JsonObject } from '../models/global-registry';

export function materializeEffectiveSpec(
  profileSpec: JsonObject | null,
  specOverrides: JsonObject,
): JsonObject {
  return profileSpec === null
    ? mergeJsonObjects({}, specOverrides)
    : mergeJsonObjects(profileSpec, specOverrides);
}
