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
- `migrations/0001_initial.sql` is the single schema migration.

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

## Single migration

The public schema is defined by `migrations/0001_initial.sql`, and `pnpm check:migrations` requires exactly that migration file. Keep schema changes in this single migration and preserve its D1-enforced invariants. Do not add a second migration, compatibility path, or schema ledger.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
