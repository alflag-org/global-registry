# Deployment

Install Global Registry with [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/alflag-org/global-registry). This is the supported production installation path for a fresh installation.

## Deploy the application

1. Open the Deploy button and connect your GitHub and Cloudflare accounts as prompted.
2. Choose the repository and Worker names. Cloudflare creates a repository in your account from the public Global Registry source.
3. Accept the detected build (`pnpm build`) and deploy (`pnpm deploy`) commands and start deployment.

Cloudflare provisions a new D1 database and the Worker, binds the database as `DB`, and writes the actual database name and ID into your repository's Wrangler configuration. The upstream UUID is a template-only resource identifier, not a production database or credential.

Workers Builds generates bindings and typechecks using the repository-pinned tools, then the deploy command applies pending D1 migrations through binding `DB` before publishing the Worker. A migration failure stops deployment. Database renaming during setup does not change this path. No application configuration values or secrets are required.

The default address is `https://<worker>.<account>.workers.dev`; a custom domain is optional. Before enabling Access, visiting the application must return **HTTP 403**. This is the expected fail-closed state. The UI, inventory, API documentation, and assets must not be accessible.

## Enable Worker-level Access

This is the only required manual step after deployment:

1. Open **Cloudflare Dashboard → Workers & Pages → your Global Registry Worker → Access**.
2. Choose **Protect this Worker behind Access**.
3. Select **All traffic** to protect production as well as previews.
4. Select the authentication policy for the people who should use the Registry.
5. Choose **Apply Access**.

If the account has not used Zero Trust, complete the prompted Zero Trust initialization first. Advanced policies can be edited in Zero Trust.

Worker-level Access covers the Worker's `workers.dev` address, custom domains, routes, and preview URLs if enabled. There is no need to configure a separate hostname-based application for installation. All identities allowed by Access can read and mutate Registry data; there is no first-admin setup or application account database.

## Verify installation

1. Before Access setup, confirm HTTP 403 at `/`, `/api/v1/locations`, `/docs`, `/openapi.json`, and `/assets/app.js`. Application content appearing without Access is a security defect; do not add inventory until corrected.
2. After applying Access, visit the Worker address and sign in through Access.
3. Confirm the UI displays, create a Location, and open **Audit Log**. Its actor must be `access:<user_uuid>`.
4. Open `/docs` and `/openapi.json` in the authenticated session.
5. Verify a signed-out browser is challenged or denied by Access and cannot read inventory.

## Machine access

For API automation, create a Cloudflare Access Service Token and permit it with a **Service Auth** policy on the Worker's Access application. Store its credentials only in the external client's secret storage.

```sh
curl --fail-with-body \
  -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
  "https://<worker>.<account>.workers.dev/api/v1/locations"
```

The flow is client → Cloudflare Access → authenticated Worker invocation → `ctx.access`. The Worker does not validate these headers directly. Service mutations are audited as `service:<service_token_id>`. Missing runtime Access context or required identity fields always cause rejection.

## Platform references

- [Deploy to Cloudflare documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) describes resource provisioning, repository configuration, and detected scripts.
- [Official D1 template](https://github.com/cloudflare/templates/tree/main/d1-template) uses a UUID template identifier and a `predeploy` migration lifecycle. Global Registry instead places the migration directly in `deploy` so it always precedes publishing without relying on lifecycle configuration.
- [Access on Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) describes Worker-level protection and local identity simulation.
- [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) describes machine credentials and policies.
