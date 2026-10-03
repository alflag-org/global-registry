# Deployment

## Choose a deployment method

### Quick deployment

Use **Deploy to Cloudflare** for evaluation, temporary use, or a quick installation. It provisions the resources and connects Workers Builds for you.

### Long-term deployment

Use **GitHub Fork + Cloudflare Workers Builds** for continued use. A real fork preserves the upstream relationship, stays in GitHub’s fork network, supports **Sync fork**, and makes contributing changes upstream through pull requests straightforward.

Both methods use `pnpm build` to generate bindings and typecheck, then `pnpm deploy` to apply D1 migrations before publishing the Worker. A migration failure stops deployment. Global Registry does not manage upstream synchronization.

## Quick deployment

1. Open [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/alflag-org/global-registry) and connect your GitHub and Cloudflare accounts as prompted.
2. Choose the repository, Worker, and database names. Cloudflare creates an independent copy of the public source in your account and provisions the Worker and D1 binding `DB`.
3. Accept the detected build command (`pnpm build`) and deploy command (`pnpm deploy`) and start deployment.
4. Enable Worker-level Access using the shared steps below.

Cloudflare configures the copied repository for the selected resources and connects Workers Builds. Migrations refer to binding `DB`, so choosing another database name during setup does not change the deployment command. No CLI or application secrets are required.

The created repository is an independent clone, not a GitHub fork: it has no upstream fork relationship, fork network membership, or **Sync fork**. It does not automatically receive upstream Global Registry changes.

## Long-term deployment

1. [Fork `alflag-org/global-registry` on GitHub](https://github.com/alflag-org/global-registry/fork). Keep the default branch, currently `master`.
2. In the target Cloudflare account, open **Storage & databases → D1 SQL database → Create database** and create a fresh database named **`global-registry-db`** before starting the first build. It must match `database_name` in `wrangler.jsonc`; the binding remains `DB`.
3. Prepare a user API token for Workers Builds with permission to deploy the Worker and **Account → D1 → Edit** on the target account. See the token details below.
4. Open **Workers & Pages → Create application → Import a repository → Get started**, connect GitHub, and select your fork.
5. Configure the project:

   | Setting           | Value                                                  |
   | ----------------- | ------------------------------------------------------ |
   | Worker name       | `global-registry` (matches `name` in `wrangler.jsonc`) |
   | Production branch | Your fork’s default branch, `master`                   |
   | Root directory    | Repository root                                        |
   | Build command     | `pnpm build`                                           |
   | Deploy command    | `pnpm deploy`                                          |
   | API token         | The token with D1 Edit permission                      |

6. Select **Save and Deploy**. Check that migrations complete before the Worker is published, then enable Worker-level Access below.

D1 must already exist because `pnpm deploy` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`. The repository-pinned Wrangler resolves `DB` through `database_name: global-registry-db` to the database UUID in the selected account. Do not deploy the application first to create the database.

The source configuration intentionally omits `database_id`. Wrangler supports resource bindings without IDs and reuses the named database at deployment. Workers Builds keeps resource state in Cloudflare; it does not require a configuration commit to your fork. Keep database IDs, account IDs, hostnames, Access AUD values, and Access team domains out of the fork. Without custom code changes, your fork’s `master` can remain identical to upstream `master`.

### Build token permissions

Workers Builds uses its selected API token for remote migrations as well as Worker deployment. Cloudflare’s automatically created Builds token does not include D1 permission in its documented defaults. In **My Profile → API Tokens**, create or edit the user token selected for the build to include **Account → D1 → Edit**, scoped to the target account, in addition to the permissions needed for Worker deployment. D1 Read alone cannot apply migrations: writes through the D1 HTTP API require D1 Edit.

Select this token during import; for an existing connection, check **Worker → Settings → Builds**. If a build failed because its token lacked D1 access, update that token and retry the build. Keep the token in Cloudflare’s build configuration, never in the repository or application secrets.

## Enable Worker-level Access

This is the only required manual step after deployment:

1. Open **Cloudflare Dashboard → Workers & Pages → your Global Registry Worker → Access**.
2. Choose **Protect this Worker behind Access**.
3. Select **All traffic** to protect production as well as previews.
4. Select the authentication policy for the people who should use the Registry.
5. Choose **Apply Access**.

If the account has not used Zero Trust, complete the prompted Zero Trust initialization first. Advanced policies can be edited in Zero Trust.

Worker-level Access covers the Worker's `workers.dev` address, custom domains, routes, and preview URLs if enabled. There is no need to configure a separate hostname-based application for installation. All identities allowed by Access can read and mutate Registry data; there is no first-admin setup or application account database.

## Updating a long-term deployment

1. In GitHub, open your fork’s production branch (`master`) and choose **Sync fork → Update branch**.
2. If the branch has no independent changes, GitHub can fast-forward it to upstream. If you have custom commits, review the merge and resolve any conflicts using GitHub’s standard fork and pull request workflow.
3. The updated production branch triggers Workers Builds, which runs `pnpm build` and `pnpm deploy`: D1 migrations first, then Worker deployment.
4. Check the build result and verify the deployment below. See [Backup and recovery](operations.md) for database recovery procedures.

Use ordinary GitHub pull requests to contribute changes upstream. No sync Action, scheduled updater, update bot, or automatic upstream merge is required or provided.

## Updating a Deploy Button copy

A Deploy to Cloudflare repository is an independent copy. If you keep using it, you are responsible for bringing upstream Global Registry changes into that repository and reconciling any configuration changes. GitHub’s **Sync fork** is unavailable. Push the reviewed changes to the production branch to trigger the same Workers Builds migration and deployment sequence.

## Verify deployment

The default address is `https://<worker>.<account>.workers.dev`; a custom domain is optional. Before enabling Access, **HTTP 403 is expected** on all application routes.

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

- [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/): repository copies, resource provisioning, and detected build/deploy commands.
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning): resource bindings without IDs and Dashboard-managed resource state.
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/): database commands and migrations.
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/): repository import and matching Worker names.
- [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/): builds triggered by repository pushes.
- [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token): build tokens and their default permissions.
- [D1 HTTP API permissions](https://developers.cloudflare.com/d1/platform/release-notes/#2025-05-02): D1 Edit required for database writes.
- [Syncing a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork): GitHub’s standard upstream update workflow.
- [Access on Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/): Worker-level protection and local identity simulation.
- [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): machine credentials and policies.
