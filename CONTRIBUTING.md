# Contributing

Keep changes focused. Preserve the provider-neutral boundary. Do not commit `.dev.vars`, `wrangler.operator.jsonc`, generated Worker declarations, local Wrangler state, SQL exports, credentials, or target-environment identifiers.

## Setup and development

The pinned tools are Node.js `24.18.0` and pnpm `11.12.0`.

```sh
mise install --locked
mise run bootstrap
mise run migrate-local
mise run dev
```

`mise run bootstrap` installs the locked dependencies, installs the locked Playwright Chromium browser, and generates Worker binding types. Local authentication is development-only and must remain on loopback; see [SECURITY.md](SECURITY.md) for the required `.dev.vars` values.

## Repository boundaries

The implementation uses one path: `route -> application -> domain -> port -> adapter`.

- `src/api/` owns HTTP route schemas, middleware, and the UI edge.
- `src/application/` owns use cases and application-facing ports.
- `src/domain/` owns models, validation, lifecycle, policy, and provider-neutral rules.
- `src/adapters/` owns Access, D1, R2, and Queue integrations.
- `migrations/` contains forward-only D1 migrations in sequence order.

Route schemas are the source for the runtime-generated OpenAPI document. Do not add a separate hand-maintained API specification. When changing routes, schemas, authorization, lifecycle transitions, exports, or operator procedures, update the implementation, focused tests, and the relevant public document.

Provider credential values must not appear in source, fixtures, logs, exports, issues, or documentation. Use uppercase credential references only. Authoritative resources and operations are not hard-deleted; use the lifecycle or status transitions provided by the API.

## Verification

```sh
mise run check
mise run smoke
mise run deploy-dry-run-local
```

Focused checks:

```sh
pnpm check:openapi
pnpm check:migrations
pnpm check:local-auth
```

Run `pnpm browser:install` before the local-auth check when the locked browser is not installed. The deployment dry run uses the inert shared configuration and does not publish a Worker.

## Forward-only migrations

`migrations/0001_initial.sql` is frozen. Do not edit it. Add schema changes as consecutively numbered files such as `0002_add_example.sql`; Wrangler and D1 own the migration ledger.

Keep migrations forward-only. Prefer an additive migration, deploy code that can use both schema shapes, migrate data in bounded work, and remove the old shape in a later migration. Do not ship a migration that immediately breaks the currently deployed Worker. `pnpm check:migrations` verifies the frozen initial hash, filename sequence, fresh installation, existing-database upgrade, integrity checks, and data preservation.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
