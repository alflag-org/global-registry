# Deployment contract

Global Registry is the Product Repository. It contains the Worker source, D1 migration
chain, deployment manifest schemas, validator, Wrangler configuration generator, and
deployment CLI. It does not contain an environment's account ID, resource IDs, Access
audience, hostname, or credential values.

The private Instance Repository contains one `release.json` and one `deployment.json` for
each environment. It selects an immutable Product commit and records the desired state for
that environment. Its workflows call this repository's CLI; they do not reimplement
deployment logic and do not copy Product source or schemas.

There is no `runtime.json`. Global Registry has no runtime configuration API, so the
Instance Repository manages runtime desired state directly through the deployment manifest.

## Manifest contract

`release.json` is strict JSON with these fields:

- `repository`: the Product repository in `owner/name` form;
- `commit`: a full, lowercase, 40-character Git commit SHA.

`deployment.json` is strict JSON with `schemaVersion: 1` and these groups:

- `accountId` and `environment`;
- `worker.name`, `worker.baseUrl`, and `worker.routes`;
- D1, R2, primary Queue, and dead-letter Queue references;
- Cloudflare Access `teamDomain` and `audience`;
- `operations.backupActorId`;
- optional observability overrides; and
- one or more Cron expressions.

The generated JSON Schemas are in [`deployment/schemas/`](../deployment/schemas/). The
validated example is in [`deployment/example/`](../deployment/example/); it contains only
sandbox values and is not a deployment target.

## Product CLI

Run the CLI from an immutable Product checkout. The Instance workflow supplies the manifest
directory and, where appropriate, the expected Product repository and commit:

```sh
pnpm deployment validate \
  --directory /path/to/environments/staging \
  --expected-environment staging \
  --source-repository owner/product \
  --source-commit <full-product-sha>

pnpm deployment generate \
  --directory /path/to/environments/staging \
  --output .work/wrangler.json

pnpm deployment dry-run --directory /path/to/environments/staging
pnpm deployment publish --directory /path/to/environments/staging
pnpm deployment deploy --directory /path/to/environments/staging
```

`generate` starts with the inert committed `wrangler.jsonc` and creates a temporary
configuration. It fills the account, Worker, route, Access, storage, Queue, observability,
Cron, and backup Actor values from the manifest. It always sets `workers_dev=false` and
`preview_urls=false`, removes shared environment overrides, and invokes Wrangler with
resource auto-creation disabled. The generated file is local execution state and must not
be committed.

`validate` checks the two manifests and release pin. `dry-run` builds the generated Worker
without uploading it. `publish` performs the dry run, checks the remote D1 migration ledger,
and publishes the Worker. `deploy` performs the same steps and then applies the Product
migrations to D1. Neither command creates or deletes Cloudflare resources, Access
applications, DNS records, or GitHub environment protection.

Before a remote publish or deploy, the CLI compares the remote D1 migration names with the
Product migration chain. An unknown remote migration stops the command before the Worker is
published. The CLI never performs an automatic rollback; restore the Instance release pin to
a known-good Product commit only after confirming migration compatibility.

## Bootstrap and acceptance

After the first migration of a fresh environment, bootstrap the first admin with the same
fixed UUID recorded as `operations.backupActorId`:

```sh
mise run bootstrap-admin -- \
  --remote \
  --database <manifest-database-name> \
  --config <generated-wrangler-config> \
  --actor-id <manifest-backup-actor-uuid> \
  --identity access:<subject> \
  --display-name "Registry Administrator"
```

Use `service:<common_name>` for a service identity. The CLI refuses a second active admin
bootstrap and verifies the admin row, audit event, and outbox row. The generated config and
the manifest must come from the same Instance commit.

Staging acceptance must cover composition, the fresh migration chain, Access protection,
Queue and dead-letter handling, R2 writes, Cron execution, health and API routes, and the
UI. Promote production through an Instance release-pin pull request only after those checks
pass. Record the Product commit, Instance commit, environment, and Worker result in the
deployment summary.

## Local development

The committed `wrangler.jsonc` remains an inert local-development configuration. Use the
local migration and development commands from the README. `pnpm deploy:dry-run:local` only
builds the local development configuration; it does not select or publish an environment.
