# Operations

## Access and Actor administration

Production registry use requires a valid Cloudflare Access JWT mapped to an active Actor. The first Actor must be an active admin. Apply migrations through the private Instance Repository, generate the matching Wrangler configuration, and run the bootstrap CLI with the fixed UUID recorded as `operations.backupActorId`:

```sh
mise run bootstrap-admin -- \
  --remote \
  --database <manifest-database-name> \
  --config <generated-wrangler-config> \
  --actor-id <manifest-backup-actor-uuid> \
  --identity access:<sub> \
  --display-name "Registry Administrator"
```

Use `service:<common_name>` for a service identity. The CLI requires no Access JWT or provider credential. It refuses to run if an admin Actor already exists, sets `role=admin` and `active=true`, uses the new Actor as its own creator and updater, and verifies the audit event and outbox row created by the existing D1 trigger.

Actor identity and creation metadata are immutable. Role and active-state changes require the expected revision, are audited, and cannot remove the final active admin or lock out the updating admin. Use the API or UI for normal Actor changes; the first-admin CLI is the bootstrap exception. Local authentication procedures and their loopback boundary are in [SECURITY.md](../SECURITY.md).

## Migration and recovery

The schema uses the forward-only SQL files in [`migrations/`](../migrations). `0001_initial.sql` is frozen. Apply pending files locally with `mise run migrate-local` or `pnpm db:migrate:local`, and verify both fresh and existing-database paths with `pnpm check:migrations`. Wrangler and D1 track applied files; the application has no separate migration ledger.

Back up and validate the database before applying pending files remotely. Keep each migration compatible with the deployed Worker. For a destructive change, expand first, deploy compatible code, migrate data in bounded work, and contract in a later release. Do not bypass application invariants with ordinary direct SQL writes.

There is no portable JSON import, seed, or legacy-restoration interface. Recovery uses a validated raw D1 SQL export and Cloudflare D1 operator recovery facilities within their supported boundary. Reconnect provider credential references through the external secret system; never restore credential values into the registry.

## Resource details and drift

Resource detail uses independent bounded cursors for relationships and drifts. Continue each collection with its own `relationshipCursor`/`relationshipLimit` or `driftCursor`/`driftLimit`. Active drift records are fingerprint-deduplicated and capped at 500 rows per resource; writes over the cap return `drift_quota_exceeded`. Resources are retired through lifecycle/status changes rather than hard-deleted.

## Resource kind definitions

Manage definitions through `/api/v1/resource-kind-definitions`. Creating the first version requires a stable lowercase kind key, lifecycle states and transitions, terminal states, placement mode, and relationship target rules. Adding a version requires the parent definition's current revision. Definition versions are immutable; existing Resources, profiles, and policies remain pinned to the version they reference.

The standard `location`, `network`, `compute`, `volume`, `service_cluster`, `service_instance`, `endpoint`, and `backup_repository` definitions use strict Core schemas. Any other key is an extension kind. Core accepts bounded, credential-free JSON for an extension Resource or profile specification and enforces its registered lifecycle, placement, and relationship rules. An extension policy may use only the common Core constraints for allowed zones and required provider capabilities. Validate extension-specific Resource and profile fields in the external adapter before provider work. Never put credential values or secret-like fields in an extension specification.

## Exports and observation archives

An export request is stored in D1, audited, and delivered through the outbox. Request an export with `POST /api/v1/exports`, then read its status with `GET /api/v1/exports/{id}`. Use the recorded R2 key and checksum only after D1 reports `succeeded`. In schema `1.3`, the key identifies `manifest.json`; the manifest lists the ordered chunks for all 25 entities, including Resource kind definition parents and versions, with their row counts and SHA-256 checksums. Each chunk contains at most 1,000 rows, and every JSON object is at most 16 MiB. The former 1,000-row-per-entity, 10,000-row-total, and single-body 16 MiB limits no longer apply; capacity grows by adding chunks.

Verify the D1 checksum against the exact serialized `manifest.json` bytes. Then verify the manifest's embedded checksum against its canonical fields excluding the checksum field and each listed chunk against its recorded checksum. The format contains credential references, never credential values. A stale claim can clean up only its revision- and token-specific prefix. Retention removes every object under the completed manifest prefix before clearing the D1 pointer.

Scheduled maintenance requires an operator-owned Cron Trigger, an active-admin `BACKUP_ACTOR_ID`, D1, R2, and Queue bindings. Each invocation archives up to 100 expired observations to R2, removes up to 100 completed exports older than 365 days, creates at most one daily export request, and dispatches up to 100 outbox rows. Observation archival writes R2 before recording the D1 pointer. Export retention deletes R2 before clearing its D1 pointer. A later bounded invocation retries an incomplete sequence.

## SQL exports

To create a raw SQL export, set the configured D1 database name or binding and an absolute output path outside the worktree. For a remote export, also set `GLOBAL_REGISTRY_REMOTE=true` and `GLOBAL_REGISTRY_WRANGLER_CONFIG` to a generated Wrangler configuration for the same Instance environment. The destination must be a new regular file; the exporter refuses overwrite, symlink, and special-file destinations.

```sh
GLOBAL_REGISTRY_DATABASE=DB \
GLOBAL_REGISTRY_EXPORT_FILE=/tmp/registry-export.sql \
pnpm export:sql
```

Validate a raw SQL export before giving it to the D1 operator recovery process:

```sh
pnpm validate:sql-export /path/to/export.sql
```

Validation rejects malformed, unsupported, or filesystem-capable SQL and checks the current schema and registry invariants in an in-memory database. This raw SQL export is the full database recovery artifact. The chunked portable export is intended for schema-versioned inspection and interchange and is not a point-in-time database image. The repository does not restore either artifact itself.

## Queue, outbox, and locks

Outbox delivery is at-least-once. A dispatcher leases at most 100 pending rows and sends each Queue message with its dispatch token. Producer sends have at most three attempts total: the initial attempt plus at most two retries. The third failure terminalizes the D1 outbox row without consuming consumer deliveries. Consumer claim, completion, and release require the current token. Duplicate or stale deliveries are acknowledged. A busy or failed current claim is retried. The generated deployment configuration allows five Queue retries after the initial delivery and uses a five-minute visibility lease; persistent failures follow the configured dead-letter policy.

Operation lock scopes are planned `resource/<key>` values. The operation creator and Actor own the lease. The lease must be current and must carry a fencing token. Fencing generations remain after release and advance on grant, renewal, expiry recovery, or reacquisition. A delayed token cannot mutate state after a newer lease. Validate real D1 concurrency in the deployed environment.

Complete an operation with `POST /api/v1/operations/{id}/complete` only after all planned resources have reached their target lifecycle and all steps are `succeeded` or `skipped`. Planned binding replacements must match the current binding, planned removals must be absent, and planned relationship creates or removals must match current D1 state. The endpoint returns `operation_completion_incomplete` without changing the operation or writing a success event when any condition is unmet.

## Operation owner recovery

Use administrative force-cancel only when the creator of a running Operation can no longer use the normal owner-and-fence mutation path. An active admin sends `POST /api/v1/operations/{id}/force-cancel` with the current Operation revision and a required reason:

```json
{
  "expectedRevision": 2,
  "reason": "The creator service identity is no longer available."
}
```

The Registry changes the Operation to `cancelled`, records an `operation.force_cancelled` audit event and matching outbox row, and includes the current lock scopes, owners, fencing tokens, and timestamps in the event payload. It then removes only that Operation's active lock rows. Per-scope lock generations remain, so a later grant receives a newer fencing token.

This endpoint performs no provider action and does not change Resource lifecycle, Operation steps, bindings, or relationships. The cancelled Operation and its immutable plan remain terminal. If work must continue, inspect current Registry and provider state, create a new Operation Plan, and acquire fresh locks.

## Routine verification

Run local verification before an operator-managed deployment:

```sh
mise run check
mise run smoke
mise run deploy-dry-run-local
```

Use [Deployment](deployment.md) for the Product manifest contract, Instance workflow sequence, migration compatibility guard, bootstrap, and deployed acceptance checks.
