import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import { violationsDetails } from '../domain/errors/violations';
import type {
  JsonObject,
  Operation,
  PolicyVersion,
  Provider,
  ProviderBinding,
  Resource,
  ResourceKindDefinitionVersion,
} from '../domain/models/global-registry';
import { isTerminalLifecycleState } from '../domain/lifecycle/lifecycle';
import { assertRunningOperationChange } from '../domain/operation/validation';
import { evaluatePolicy } from '../domain/policy/evaluator';
import { evaluateProviderCompatibility } from '../domain/provider/compatibility';

interface BindingStore {
  getResource(key: string): Promise<Resource | null>;
  getResourceKindDefinition(
    key: string,
    version: number,
  ): Promise<ResourceKindDefinitionVersion | null>;
  getProvider(id: string): Promise<Provider | null>;
  getOperation(id: string): Promise<Operation | null>;
  getPolicyVersion(namespace: string, key: string, version: number): Promise<PolicyVersion | null>;
  replaceBinding(
    input: ReplaceBindingCommand & {
      expectedProviderRevision: number;
      expectedProviderBindingRevision: number;
    },
  ): Promise<ProviderBinding>;
  removeBinding(input: RemoveBindingCommand): Promise<void>;
}

interface ReplaceBindingCommand {
  resourceKey: string;
  providerId: string;
  providerResourceType: string;
  providerResourceId: string;
  providerResourceName?: string;
  locator: JsonObject;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

interface RemoveBindingCommand {
  resourceKey: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export class BindingService {
  constructor(private readonly store: BindingStore) {}

  async replace(input: ReplaceBindingCommand): Promise<ProviderBinding> {
    const resource = await this.loadResourceAtRevision(input.resourceKey, input.expectedRevision);
    const definition = await this.loadDefinition(resource);
    if (isTerminalLifecycleState(definition, resource.lifecycleState)) {
      throw new ConflictError(
        'resource_terminal',
        'A Resource in a terminal lifecycle state cannot receive a provider binding.',
        { resourceKey: resource.key },
      );
    }
    const provider = await this.store.getProvider(input.providerId);
    if (provider === null) throw new NotFoundError('Provider', input.providerId);
    const operation = await this.loadOperation(input.operationId);
    assertRunningOperationChange(operation, {
      action: 'binding.replace',
      resourceKey: input.resourceKey,
      providerId: input.providerId,
      providerResourceType: input.providerResourceType,
      providerResourceId: input.providerResourceId,
    });

    const binding: ProviderBinding = {
      resourceId: resource.id,
      providerId: provider.id,
      providerResourceType: input.providerResourceType,
      providerResourceId: input.providerResourceId,
      ...(input.providerResourceName === undefined
        ? {}
        : { providerResourceName: input.providerResourceName }),
      locator: input.locator,
      boundAt: new Date(0).toISOString(),
      boundBy: input.actorId,
    };
    const compatibility = evaluateProviderCompatibility({ resource, provider, definition });
    if (!compatibility.valid) {
      throw new ValidationError(
        'provider_incompatible',
        'The provider cannot satisfy this resource.',
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
      const evaluation = evaluatePolicy({ resource, policy, definition, provider, binding });
      if (!evaluation.valid) {
        throw new ValidationError(
          'policy_violation',
          'The provider binding violates the selected policy.',
          violationsDetails(evaluation.violations),
        );
      }
    }
    return this.store.replaceBinding({
      ...input,
      expectedProviderRevision: provider.revision,
      expectedProviderBindingRevision: provider.bindingRevision,
    });
  }

  async remove(input: RemoveBindingCommand): Promise<void> {
    const resource = await this.loadResourceAtRevision(input.resourceKey, input.expectedRevision);
    const definition = await this.loadDefinition(resource);
    if (!isTerminalLifecycleState(definition, resource.lifecycleState)) {
      throw new ConflictError(
        'binding_removal_lifecycle_conflict',
        'A provider binding can be removed only from a Resource in a terminal lifecycle state.',
        { resourceKey: resource.key, lifecycleState: resource.lifecycleState },
      );
    }
    const operation = await this.loadOperation(input.operationId);
    assertRunningOperationChange(operation, {
      action: 'binding.remove',
      resourceKey: input.resourceKey,
    });
    await this.store.removeBinding(input);
  }

  private async loadResourceAtRevision(key: string, expectedRevision: number): Promise<Resource> {
    const resource = await this.store.getResource(key);
    if (resource === null) throw new NotFoundError('Resource', key);
    if (resource.revision !== expectedRevision) {
      throw new ConflictError('revision_conflict', 'Resource revision is stale.', {
        key,
        expectedRevision,
        currentRevision: resource.revision,
      });
    }
    return resource;
  }

  private async loadOperation(id: string): Promise<Operation> {
    const operation = await this.store.getOperation(id);
    if (operation === null) throw new NotFoundError('Operation', id);
    return operation;
  }

  private async loadDefinition(resource: Resource): Promise<ResourceKindDefinitionVersion> {
    const definition = await this.store.getResourceKindDefinition(
      resource.kind,
      resource.kindVersion,
    );
    if (definition === null) {
      throw new NotFoundError(
        'Resource kind definition',
        `${resource.kind}@${resource.kindVersion}`,
      );
    }
    return definition;
  }
}
