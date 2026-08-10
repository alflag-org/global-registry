# Deployment

Global Registry runs as a Cloudflare Worker with one D1 database, one R2 bucket, one primary Queue, one dead-letter Queue, and an operator-owned Cron Trigger. The committed `wrangler.jsonc` is an inert shared configuration: deployment values are unset, workers.dev and preview URLs are disabled, and storage names are local simulation values.

## Operator overlay

Create the ignored `wrangler.operator.jsonc` from `wrangler.operator.example.jsonc`. Replace every operator placeholder with values for the target environment:

- Worker name and Cloudflare account ID;
- HTTPS Cloudflare Access team domain and application audience;
- an active admin Actor ID in `BACKUP_ACTOR_ID`;
- D1 database name and ID;
- R2 bucket name;
- the primary Queue and dead-letter Queue names; and
- at least one operator-owned Cron Trigger.

Keep `ENVIRONMENT=production`, `ALLOW_LOCAL_AUTH=false`, `workers_dev=false`, and `preview_urls=false`. Do not put provider credential values or unrelated secrets in the overlay. The overlay is ignored and must not be committed.

## Preflight and deployment sequence

The remote commands are gated by the deployment preflight. Run them in this order after completing the overlay:

```sh
pnpm deploy:preflight
pnpm deploy:dry-run
pnpm db:migrate:remote
pnpm deploy
```

`pnpm deploy:preflight` validates the operator configuration, binding names, production authentication settings, disabled public exposure, required resource identifiers, Queue recovery settings, and Cron Trigger. `pnpm deploy:dry-run` builds the Worker without publishing it. `pnpm db:migrate:remote` applies every pending file in `migrations/` through the Wrangler/D1 migration ledger. `pnpm deploy` publishes the Worker after running its preflight guard again.

Before applying a remote migration, confirm the dry-run bundle and target account, create a raw D1 SQL export, and validate that export. The command order above is for additive migrations compatible with the deployed Worker. Split a destructive schema change across releases: expand the schema, deploy compatible code, migrate data in bounded work, then contract the schema only after the old Worker shape is no longer in use. Do not use direct unguarded Wrangler commands for the remote migration or deployment.

## Operator acceptance

After the migration and deployment:

1. If the database has no Actor, insert the first active admin through the D1 operator console using `access:<sub>` or `service:<common_name>` as the Actor identity and the same Actor ID in `created_by` and `updated_by`.
2. Confirm Cloudflare Access protects the registry API, `/healthz`, `/openapi.json`, `/docs`, and the main UI.
3. Confirm the active `BACKUP_ACTOR_ID` can run scheduled maintenance.
4. Exercise the deployed Access session and cookie policy, D1 concurrency, and Queue/R2 partial-failure recovery.

These are deployment acceptance checks. Local validation does not prove the target Access cookie behavior, Cloudflare scheduling, or service concurrency and partial-failure behavior.
