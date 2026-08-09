import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type { CreateActorCommand, UpdateActorCommand } from '../../domain/actor/schemas';
import type { Actor } from '../../domain/models/global-registry';
import { boundedPageLimit } from '../../domain/models/pagination';
import { D1Client, type SqlValue } from './client';
import { mapActor } from './rows';
import type { ActorRow } from './types';

export type CreateActorInput = CreateActorCommand & { id?: string };
export type UpdateActorInput = UpdateActorCommand;

export class D1Actors extends D1Client {
  async getByIdentity(identity: string): Promise<Actor | null> {
    const row = await this.first<ActorRow>('SELECT * FROM actors WHERE identity = ?', identity);
    return row === null ? null : mapActor(row);
  }

  async get(id: string): Promise<Actor | null> {
    const row = await this.first<ActorRow>('SELECT * FROM actors WHERE id = ?', id);
    return row === null ? null : mapActor(row);
  }

  async list(limit?: number): Promise<Actor[]> {
    return (
      await this.all<ActorRow>(
        'SELECT * FROM actors ORDER BY display_name, id LIMIT ?',
        boundedPageLimit(limit),
      )
    ).map(mapActor);
  }

  async create(input: CreateActorInput): Promise<Actor> {
    const createdAt = new Date().toISOString();
    const actorId = input.id ?? crypto.randomUUID();
    try {
      const insert = this.statement(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        )
        VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        actorId,
        input.identity,
        input.displayName,
        input.role,
        createdAt,
        createdAt,
        input.actorId,
        input.actorId,
      );
      const results = await this.db.batch([
        insert,
        this.statement('SELECT * FROM actors WHERE id = ?', actorId),
      ]);
      const row = results[1]?.results[0] as ActorRow | undefined;
      if (row === undefined) throw new NotFoundError('Actor', actorId);
      return mapActor(row);
    } catch (error) {
      throw translateActorWriteError(error);
    }
  }

  async update(input: UpdateActorInput): Promise<Actor> {
    const updatedAt = new Date().toISOString();
    const assignments = ['revision = revision + 1', 'updated_at = ?', 'updated_by = ?'];
    const params: SqlValue[] = [updatedAt, input.actorId];
    if (input.displayName !== undefined) {
      assignments.push('display_name = ?');
      params.push(input.displayName);
    }
    if (input.role !== undefined) {
      assignments.push('role = ?');
      params.push(input.role);
    }
    if (input.active !== undefined) {
      assignments.push('active = ?');
      params.push(input.active ? 1 : 0);
    }
    if (input.displayName === undefined && input.role === undefined && input.active === undefined) {
      throw new Error('Actor persistence command must contain a mutable field.');
    }
    params.push(input.id, input.expectedRevision);
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        this.statement(
          `UPDATE actors SET ${assignments.join(', ')} WHERE id = ? AND revision = ?`,
          ...params,
        ),
        this.statement('SELECT * FROM actors WHERE id = ?', input.id),
      ]);
    } catch (error) {
      throw translateActorWriteError(error);
    }
    const row = results[1]?.results[0] as ActorRow | undefined;
    if ((results[0]?.meta.changes ?? 0) === 0) {
      if (row === undefined) throw new NotFoundError('Actor', input.id);
      throw new ConflictError('revision_conflict', 'Actor revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: row.revision,
      });
    }
    if (row === undefined) throw new NotFoundError('Actor', input.id);
    return mapActor(row);
  }
}

function translateActorWriteError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.message.includes('UNIQUE constraint failed: actors.identity')) {
    return new ConflictError(
      'duplicate_actor_identity',
      'An actor already uses this canonical identity.',
    );
  }
  if (
    error.message.includes('actor_last_active_admin_required') ||
    error.message.includes('actor_active_admin_required')
  ) {
    return new ConflictError('last_active_admin', 'At least one active administrator must remain.');
  }
  if (error.message.includes('actor_self_lockout_required')) {
    return new ConflictError(
      'self_lockout',
      'Another active administrator is required before changing your own access.',
    );
  }
  if (error.message.includes('actor_immutable_fields')) {
    return new ConflictError(
      'immutable_actor_field',
      'Actor id, identity, createdAt, and createdBy are immutable.',
    );
  }
  return error;
}
