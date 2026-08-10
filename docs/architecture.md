# Architecture

Global Registry is a Cloudflare Worker that stores provider-neutral desired state. It does not make provider API calls and does not store provider credential values.

## Runtime and storage

```text
Cloudflare Access
        |
        v
Worker: HTTP API, UI, Queue consumer, scheduled maintenance
        |
        +-- D1: authoritative state, revisions, audit, outbox, locks, export status
        +-- Queue: delivery of persisted outbox events
        `-- R2: exports and archived observations
```

D1 is authoritative for registry objects and their history. R2 is an object store for completed exports and archived observations. Queue delivery is at-least-once and starts only from D1 outbox records.

The implementation follows one layer path:

```text
route -> application -> domain -> port -> adapter
```

Routes translate HTTP input through application use cases. Domain code validates provider-neutral rules and lifecycle transitions. Application ports define persistence and external-service contracts. The Worker composition boundary selects the D1, R2, Queue, and Access adapters.

## Registry state and invariants

The registry models Actors, resources, providers, versioned profiles and policies, provider bindings, relationships, health, observations, drift, operations, audit events, exports, and outbox records.

Resources have immutable keys, a provider-neutral kind, a lifecycle state, a separate health state, an effective JSON specification, and an optimistic revision. Profile and policy versions are append-only, and a resource keeps the version it references. Provider bindings store provider resource identifiers and credential references, not credential values. Authoritative resources, providers, profiles, policies, Actors, and operations are not hard-deleted; the model uses retirement or deactivation and retains the relevant history.

An operation stores an immutable plan and SHA-256 plan hash. Its resource scopes are planned before locks are acquired. A lock belongs to the operation creator and Actor, expires, and carries a fencing token backed by a retained per-scope generation. Mutations that use an operation verify the current lease and fencing token. Revision and fencing failures prevent stale state from being written.

Entering `succeeded` uses a dedicated completion path. In the same fenced D1 batch that updates the operation and records its audit/outbox entries, the registry requires every planned resource to be at its target lifecycle, every step to be `succeeded` or `skipped`, and every Registry-visible binding or relationship change to match its planned postcondition. Other terminal statuses use the ordinary status-transition path.

State changes, audit events, and outbox rows are written atomically in D1. A failed compare-and-swap mutation does not create an audit event. Persisted JSON and audit payloads are normalized and bounded before storage.

## Authentication path

In production, Cloudflare Access authenticates the request. The Worker verifies the issuer, audience, RS256 signature, and time claims, derives a canonical identity (`access:<sub>` or `service:<common_name>`), and maps it to an active Actor before route authorization. Local authentication is a separate development-only loopback path; its boundary is defined in [SECURITY.md](../SECURITY.md).

## HTTP and UI contracts

OpenAPI 3.1 is generated from the runtime route schemas and served at authenticated `/openapi.json`. Authenticated `/docs` uses repository-hosted JavaScript and CSS assets with a self-only Content Security Policy; it does not use a CDN or `unsafe-inline`. The UI uses the same API authorization and revision rules as direct clients.

Mutation bodies must be `application/json`, are checked against the actual streamed 1 MiB body limit, and are subject to bounded JSON depth and node-count rules. Errors have structured codes and request IDs. Resource lists use bounded keyset pagination. Resource detail returns independent bounded cursors for relationships and drifts; active drift records are fingerprint-deduplicated and limited to 500 rows per resource.

## Async delivery and exports

Mutations persist an audit event and its outbox record in D1. Dispatch leases pending rows before sending Queue messages and carries the lease token into consumer claim, completion, and release. Duplicate or stale deliveries cannot complete a newer lease; failures are retried within the configured bounds. This is at-least-once delivery, not exactly-once delivery or snapshot isolation.

An export request is persisted in D1 and processed through the outbox. Portable export schema `1.2` represents all 23 registry entities as ordered JSON chunks under a revision- and claim-token-specific R2 prefix. D1 captures a row ceiling for each entity, then reads at most 1,000 rows at a time. The Worker validates each row against that entity's schema, serializes at most one 16 MiB object, supplies its SHA-256 digest for R2 upload integrity validation, verifies the stored metadata, and continues without retaining prior chunk bodies in memory.

The Worker renews the same revision- and token-fenced export lease after verifying each chunk. It writes `manifest.json` only after every entity chunk is present. The manifest records each chunk's entity, sequence, key, row count, and checksum. Its embedded checksum covers the canonical manifest fields other than the checksum field itself. D1 stores the SHA-256 checksum of the complete serialized manifest object and its R2 key only after fenced completion. A failed or stale claim can delete only its token-specific prefix. Provider credential values are never emitted, and the repository has no portable JSON importer.

The portable format is schema-validated and inspectable, but its bounded reads are not a database transaction or a point-in-time recovery image. A raw D1 SQL export remains the full database recovery artifact. D1 operator recovery, not portable JSON import, restores authoritative state.

Scheduled maintenance requires an operator-owned Cron Trigger, an active admin Actor in `BACKUP_ACTOR_ID`, and the asynchronous bindings. It archives expired observations, prunes retained exports, creates the daily export request, and dispatches pending outbox rows in bounded work units.

The schema is built from the forward-only SQL files in [`migrations/`](../migrations). `0001_initial.sql` is frozen; later files use contiguous sequence numbers and are recorded by the Wrangler/D1 migration ledger. The repository does not maintain a second ledger. D1 constraints and triggers enforce identity, active-admin, lifecycle, JSON, revision, append-only, fencing-generation, foreign-key, and relationship invariants.
