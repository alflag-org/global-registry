import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import { violationsDetails } from '../domain/errors/violations';
import type {
  JsonObject,
  PolicyVersion,
  Provider,
  ProviderBinding,
  Resource,
} from '../domain/models/global-registry';
import { evaluatePolicy } from '../domain/policy/evaluator';
import { evaluateProviderCompatibility } from '../domain/provider/compatibility';
import type { ProviderStatus } from '../domain/provider/model';
import { validateProviderDefinition } from '../domain/provider/validation';

interface ProviderStore {
  getProvider(id: string): Promise<Provider | null>;
  createProvider(input: {
    id: string;
    driver: string;
    credentialRef: string;
    status: ProviderStatus;
    capabilities: JsonObject;
    mappings: JsonObject;
    actorId: string;
  }): Promise<Provider>;
  updateProvider(input: {
    id: string;
    expectedRevision: number;
    expectedBindingRevision: number;
    expectedBoundResourceCount: number;
    actorId: string;
    driver: string;
    credentialRef: string;
    status: ProviderStatus;
    capabilities: JsonObject;
    mappings: JsonObject;
    expectedBoundResources: Array<{
      id: string;
      key: string;
      revision: number;
    }>;
  }): Promise<Provider>;
  listBindingsForProvider(
    providerId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: Array<{ binding: ProviderBinding; resource: Resource }>;
    nextCursor?: string;
  }>;
  getPolicyVersion(namespace: string, key: string, version: number): Promise<PolicyVersion | null>;
}

interface CreateProviderCommand {
  actorId: string;
  id: string;
  driver: string;
  credentialRef: string;
  status: ProviderStatus;
  capabilities: JsonObject;
  mappings: JsonObject;
}

interface UpdateProviderCommand {
  actorId: string;
  id: string;
  expectedRevision: number;
  driver?: string;
  credentialRef?: string;
  status?: ProviderStatus;
  capabilities?: JsonObject;
  mappings?: JsonObject;
}

export class ProviderService {
  constructor(private readonly store: ProviderStore) {}

  async create(input: CreateProviderCommand): Promise<Provider> {
    const candidate = validateProviderDefinition({
      id: input.id,
      driver: input.driver,
      credentialRef: input.credentialRef,
      status: input.status,
      capabilities: input.capabilities,
      mappings: input.mappings,
    });
    return this.store.createProvider({ ...candidate, actorId: input.actorId });
  }

  async update(input: UpdateProviderCommand): Promise<Provider> {
    const current = await this.store.getProvider(input.id);
    if (current === null) throw new NotFoundError('Provider', input.id);
    if (current.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Provider revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    if (
      input.driver === undefined &&
      input.credentialRef === undefined &&
      input.status === undefined &&
      input.capabilities === undefined &&
      input.mappings === undefined
    ) {
      throw new ValidationError(
        'empty_provider_patch',
        'At least one mutable provider field is required.',
      );
    }
    const status = input.status ?? current.status;
    if (current.status === 'retired' && status !== 'retired') {
      throw new ConflictError('provider_retired', 'A retired provider cannot be reactivated.', {
        id: current.id,
      });
    }
    const candidateDefinition = validateProviderDefinition({
      id: current.id,
      driver: input.driver ?? current.driver,
      credentialRef: input.credentialRef ?? current.credentialRef,
      status,
      capabilities: input.capabilities ?? current.capabilities,
      mappings: input.mappings ?? current.mappings,
    });
    const candidate: Provider = {
      ...current,
      ...candidateDefinition,
      revision: current.revision + 1,
    };
    const activeBindings: Array<{ binding: ProviderBinding; resource: Resource }> = [];
    let cursor: string | undefined;
    while (true) {
      const page = await this.store.listBindingsForProvider(current.id, cursor, 50);
      activeBindings.push(...page.items);
      if (page.nextCursor === undefined) break;
      if (page.nextCursor === cursor) {
        throw new ConflictError(
          'provider_binding_pagination_invalid',
          'Provider binding pagination did not advance.',
          { id: current.id },
        );
      }
      cursor = page.nextCursor;
    }
    if (candidate.status === 'retired' && activeBindings.length > 0) {
      throw new ConflictError(
        'provider_has_active_bindings',
        'A provider with active bindings cannot be retired.',
        { id: candidate.id, activeBindingCount: activeBindings.length },
      );
    }

    for (const { binding, resource } of activeBindings) {
      const compatibility = evaluateProviderCompatibility({
        resource,
        provider: candidate,
        binding,
        requireActive: false,
      });
      if (!compatibility.valid) {
        throw new ValidationError(
          'provider_incompatible',
          'The provider update would invalidate an active binding.',
          violationsDetails(compatibility.violations),
        );
      }
      if (resource.policy !== undefined) {
        const policy = await this.store.getPolicyVersion(
          resource.policy.namespace,
          resource.policy.key,
          resource.policy.version,
        );
        if (policy === null) {
          throw new NotFoundError(
            'Policy version',
            `${resource.policy.namespace}/${resource.policy.key}@${resource.policy.version}`,
          );
        }
        const evaluation = evaluatePolicy({ resource, policy, provider: candidate, binding });
        if (!evaluation.valid) {
          throw new ValidationError(
            'policy_violation',
            'The provider update would violate a bound resource policy.',
            violationsDetails(evaluation.violations),
          );
        }
      }
    }

    return this.store.updateProvider({
      ...candidateDefinition,
      expectedRevision: input.expectedRevision,
      expectedBindingRevision: current.bindingRevision,
      expectedBoundResourceCount: activeBindings.length,
      expectedBoundResources: activeBindings.map(({ resource }) => ({
        id: resource.id,
        key: resource.key,
        revision: resource.revision,
      })),
      actorId: input.actorId,
    });
  }
}
