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

A provider driver is an extensible lowercase identifier, not a Core enum. Provider capabilities declare supported resource kinds, stable feature identifiers such as `compute.vm` or `custom.example.foo`, and architectures. Core compares those declarations with resource, placement, and policy requirements. Provider configuration, mappings, and provider resource types are bounded non-secret data interpreted by an external adapter. Core preserves them but does not contain driver-specific schemas or validate provider API identifiers.

An operation stores an immutable plan and SHA-256 plan hash. Its resource scopes are planned before locks are acquired. A lock belongs to the operation creator and Actor, expires, and carries a fencing token backed by a retained per-scope generation. Mutations that use an operation verify the current lease and fencing token. Revision and fencing failures prevent stale state from being written.

State changes, audit events, and outbox rows are written atomically in D1. A failed compare-and-swap mutation does not create an audit event. Persisted JSON and audit payloads are normalized and bounded before storage.

## Authentication path

In production, Cloudflare Access authenticates the request. The Worker verifies the issuer, audience, RS256 signature, and time claims, derives a canonical identity (`access:<sub>` or `service:<common_name>`), and maps it to an active Actor before route authorization. Local authentication is a separate development-only loopback path; its boundary is defined in [SECURITY.md](../SECURITY.md).

## HTTP and UI contracts

OpenAPI 3.1 is generated from the runtime route schemas and served at authenticated `/openapi.json`. Authenticated `/docs` uses repository-hosted JavaScript and CSS assets with a self-only Content Security Policy; it does not use a CDN or `unsafe-inline`. The UI uses the same API authorization and revision rules as direct clients.

Mutation bodies must be `application/json`, are checked against the actual streamed 1 MiB body limit, and are subject to bounded JSON depth and node-count rules. Errors have structured codes and request IDs. Resource lists use bounded keyset pagination. Resource detail returns independent bounded cursors for relationships and drifts; active drift records are fingerprint-deduplicated and limited to 500 rows per resource.

## Async delivery and exports

Mutations persist an audit event and its outbox record in D1. Dispatch leases pending rows before sending Queue messages and carries the lease token into consumer claim, completion, and release. Duplicate or stale deliveries cannot complete a newer lease; failures are retried within the configured bounds. This is at-least-once delivery, not exactly-once delivery or snapshot isolation.

An export request is persisted in D1 and processed through the outbox. The portable JSON format is schema `1.2` and contains the 23 registry tables. D1 reads the snapshot in one ordered batch. It caps each table at 1,000 rows and the snapshot at 10,000 rows and 16 MiB after serialization. It validates cross-table invariants, then writes a checksummed object to R2. Each claim owns a revision-, token-, and object-key-specific object. D1 records the successful object only after fenced completion. Exports contain credential references and non-secret provider configuration, never credential values. The repository has no portable JSON importer.

Scheduled maintenance requires an operator-owned Cron Trigger, an active admin Actor in `BACKUP_ACTOR_ID`, and the asynchronous bindings. It archives expired observations, prunes retained exports, creates the daily export request, and dispatches pending outbox rows in bounded work units.

The schema is built from the forward-only SQL files in [`migrations/`](../migrations). `0001_initial.sql` is frozen; later files use contiguous sequence numbers and are recorded by the Wrangler/D1 migration ledger. The repository does not maintain a second ledger. D1 constraints and triggers enforce identity, active-admin, lifecycle, JSON, revision, append-only, fencing-generation, foreign-key, and relationship invariants.
