import { ValidationError } from '../errors/global-registry-error';
import { violationsDetails, zodViolations } from '../errors/violations';
import { ensureCredentialFreeJsonObject, ensureJsonObject } from '../models/json';
import type { JsonObject } from '../models/global-registry';
import type { ProviderStatus } from './model';
import { providerDefinitionSchema } from './schemas';

interface ValidatedProviderDefinition {
  id: string;
  driver: string;
  credentialRef: string;
  status: ProviderStatus;
  capabilities: JsonObject;
  configuration: JsonObject;
  mappings: JsonObject;
}

export function validateProviderDefinition(value: unknown): ValidatedProviderDefinition {
  const result = providerDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'invalid_provider',
      'Provider definition is invalid.',
      violationsDetails(zodViolations(result.error)),
    );
  }
  return {
    id: result.data.id,
    driver: result.data.driver,
    credentialRef: result.data.credentialRef,
    status: result.data.status,
    capabilities: ensureJsonObject(result.data.capabilities, 'provider capabilities'),
    configuration: ensureCredentialFreeJsonObject(
      result.data.configuration,
      'provider configuration',
    ),
    mappings: ensureCredentialFreeJsonObject(result.data.mappings, 'provider mappings'),
  };
}
