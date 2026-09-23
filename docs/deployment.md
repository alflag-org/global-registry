# Deployment

Deploy one Worker, one D1 database, and a Cloudflare Access self-hosted application covering the entire Worker hostname. Keep real account IDs, database IDs, routes, and Access audience values in private environment configuration outside this repository.

## Database and Worker

Create a new D1 database for this schema. Export any older installation separately if needed; there is no in-place upgrade or importer.

```sh
pnpm exec wrangler d1 create global-registry
```

Create a private Wrangler configuration based on `wrangler.jsonc`. Set an absolute `main` path to this checkout's `src/index.ts`, an absolute `migrations_dir` path, the Worker name/account/route, and the created `database_name` and `database_id` for binding `DB`. Keep `workers_dev` and `preview_urls` disabled. Do not copy the `development` environment into a production configuration.

Automated deploys run from the private `alflag-org/global-registry-deploy` repository, which owns the production Wrangler configuration and a manual dispatch workflow for this Worker. This repository intentionally carries placeholders only.

Set production variables:

- `ENVIRONMENT = "production"`
- `ALLOW_LOCAL_AUTH = "false"`
- `ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"`
- `ACCESS_AUD = "<Access application audience tag>"`
- `LOCAL_AUTH_SECRET = "unset"`
- `LOCAL_ACTOR_IDENTITY = "unset"`

Apply all pending migrations, inspect the deployment bundle, then deploy using the private configuration:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config /absolute/private/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config /absolute/private/wrangler.jsonc
pnpm exec wrangler deploy --config /absolute/private/wrangler.jsonc
```

Verify that unauthenticated access is blocked, then sign in and create a Location through the UI. Confirm the resulting audit entry. Check `/openapi.json` and `/docs` through Access. Inventory writes through direct D1 SQL bypass application audit and canonicalization and are not a supported operational workflow.

## Human and machine access

Configure an Access Allow policy for the intended people and a Service Auth policy for the intended Service Tokens. All admitted identities have the same application capabilities; there is no Registry account database or role mapping. Audit actors use signed JWT subjects (`access:<sub>`) or Service Token client IDs (`service:<common_name>`).

The Worker verifies the Access application JWT, including its RS256 signature, issuer, audience, expiration, and optional not-before time. Merely supplying identity headers or Service Token headers directly to the Worker does not authenticate a request.

Machine clients send `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the Access-protected hostname. Access validates those credentials and supplies `Cf-Access-Jwt-Assertion` to the Worker. Store Service Token secrets only in the external client's secret storage. No provider credentials or Service Token secrets belong in Registry data.

```sh
curl --fail-with-body \
  -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
  https://registry.example.com/api/v1/locations
```

Consult Cloudflare's [application token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) and [Service Token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) for Access policy setup and token handling.

When upgrading an inventory database, apply all pending migrations before serving the updated Worker. Migration `0002_source_identifiers.sql` rejects existing noncanonical source values instead of silently rewriting identities. Correct them through the authenticated API first, resolving any duplicate triples, so changes remain audited.
