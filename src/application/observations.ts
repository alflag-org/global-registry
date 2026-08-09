import { ConflictError, NotFoundError } from '../domain/errors/global-registry-error';
import type {
  Drift,
  Health,
  JsonObject,
  Observation,
  Resource,
} from '../domain/models/global-registry';

interface ObservationStore {
  getResource(key: string): Promise<Resource | null>;
  getHealth(resourceKey: string): Promise<Health | null>;
  putHealth(input: {
    resourceKey: string;
    status: Health['status'];
    reason?: string;
    observedAt: string;
    expectedRevision: number;
    actorId: string;
  }): Promise<Health>;
  createObservation(input: {
    resourceKey: string;
    observedAt: string;
    facts: JsonObject;
    retentionHours: number;
    actorId: string;
  }): Promise<Observation>;
  createDrift(input: {
    resourceKey: string;
    severity: Drift['severity'];
    expected: JsonObject;
    observed: JsonObject;
    actorId: string;
  }): Promise<Drift>;
  getDrift(id: string): Promise<Drift | null>;
  updateDrift(input: {
    id: string;
    status: Drift['status'];
    expectedRevision: number;
    actorId: string;
  }): Promise<Drift>;
}

export class ObservationService {
  constructor(private readonly store: ObservationStore) {}

  async putHealth(input: {
    resourceKey: string;
    status: Health['status'];
    reason?: string;
    observedAt: string;
    expectedRevision: number;
    actorId: string;
  }): Promise<Health> {
    await this.requireResource(input.resourceKey);
    const current = await this.store.getHealth(input.resourceKey);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Health revision is stale.', {
        resourceKey: input.resourceKey,
        expectedRevision: input.expectedRevision,
        currentRevision,
      });
    }
    return this.store.putHealth(input);
  }

  async createObservation(input: {
    resourceKey: string;
    observedAt: string;
    facts: JsonObject;
    retentionHours: number;
    actorId: string;
  }): Promise<Observation> {
    await this.requireResource(input.resourceKey);
    return this.store.createObservation(input);
  }

  async createDrift(input: {
    resourceKey: string;
    severity: Drift['severity'];
    expected: JsonObject;
    observed: JsonObject;
    actorId: string;
  }): Promise<Drift> {
    await this.requireResource(input.resourceKey);
    return this.store.createDrift(input);
  }

  async updateDrift(input: {
    id: string;
    status: Drift['status'];
    expectedRevision: number;
    actorId: string;
  }): Promise<Drift> {
    const current = await this.store.getDrift(input.id);
    if (current === null) throw new NotFoundError('Drift', input.id);
    if (current.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Drift revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    if (current.status === input.status) {
      throw new ConflictError('drift_status_unchanged', `The drift is already ${input.status}.`);
    }
    return this.store.updateDrift(input);
  }

  private async requireResource(key: string): Promise<void> {
    if ((await this.store.getResource(key)) === null) throw new NotFoundError('Resource', key);
  }
}
