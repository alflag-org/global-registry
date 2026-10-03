# Deployment

Use **Quick deployment** for evaluation or temporary use. Use **Long-term deployment** for a GitHub fork that can receive upstream updates through **Sync fork**.

Both use `pnpm build` and `pnpm deploy`. Deployment applies D1 migrations before publishing the Worker and stops if migration fails.

## Quick deployment

1. Open [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/alflag-org/global-registry) and connect your GitHub and Cloudflare accounts as prompted.
2. Choose the repository, Worker, and database names. Cloudflare creates an independent copy of the public source in your account and provisions the Worker and D1 binding `DB`.
3. Accept the detected build command (`pnpm build`) and deploy command (`pnpm deploy`) and start deployment.
4. In the Worker’s **Settings → Build → Branch control** (shown as **Builds** in some Dashboard views), confirm the production branch matches the copied repository’s default branch and disable preview builds for this production setup.
5. Enable Worker-level Access using the shared steps below.

The repository is an independent copy, not a GitHub fork. It has no **Sync fork** and does not receive upstream changes automatically. Migrations use binding `DB`, so the database name chosen during setup can differ from the source configuration.

## Long-term deployment

1. [Fork `alflag-org/global-registry` on GitHub](https://github.com/alflag-org/global-registry/fork). Keep the default branch, currently `master`.
2. In the target Cloudflare account, open **Storage & databases → D1 SQL database → Create database** and create a fresh database named **`global-registry-db`** before starting the first build. It must match `database_name` in `wrangler.jsonc`; the binding remains `DB`.
3. In **Workers & Pages**, choose **Create application**. On **Create an app → Make something new**, select **Continue with GitHub**.
4. On **Select a repository**, choose the GitHub account that owns your fork, select that fork’s `global-registry` repository, and choose **Next**. Use the existing fork from the repository list; **Clone a public repository via Git URL** creates a separate copy.
5. On **Set up your application**, configure every field as follows:

   | Field                          | Value                                                                                                          |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
   | Project name                   | `global-registry` (matches `name` in `wrangler.jsonc`)                                                         |
   | Build command                  | `pnpm build`                                                                                                   |
   | Deploy command                 | `pnpm deploy`                                                                                                  |
   | Preview command                | `npx wrangler preview` (leave the default; unused with Preview builds disabled)                                |
   | Enable Preview builds          | **Off**                                                                                                        |
   | Protect with Cloudflare Access | **Off** here; configure Worker-level Access with **All traffic** after deployment using the shared steps below |
   | Advanced settings → Path       | `/` (repository root)                                                                                          |
   | API token                      | Use the token offered by the import flow; no separate manual token preparation is required                     |
   | Variable name / Variable value | Leave empty; no build variables or application secrets are required                                            |
   | Encrypt                        | No action required while variable fields are empty                                                             |

6. Select **Deploy**. Check that migrations complete before the Worker is published.
7. In the Worker’s **Settings → Build → Branch control** (shown as **Builds** in some Dashboard views), confirm the production branch is your fork’s default branch, `master`, and Preview builds remain disabled. Then enable Worker-level Access below.

Preview builds are disabled because this setup covers production only. A preview requires separate database, migration, and Access setup. `preview_urls: false` does not disable Workers Builds preview builds.

Create D1 before the first build: `pnpm deploy` runs remote migrations before Worker deployment. Wrangler resolves binding `DB` by database name, so no `database_id` is needed. Keep resource IDs and production Access settings in Cloudflare rather than committing them to the fork.

### Troubleshoot D1 permission errors

If remote migrations fail with an authorization or permission error, check the token selected in **Worker → Settings → Builds**. In **My Profile → API Tokens**, ensure that token includes **Account → D1 → Edit** on the target account, then retry the build. Keep the token in Cloudflare’s build configuration, outside the repository.

## Enable Worker-level Access

1. Open **Cloudflare Dashboard → Workers & Pages → your Global Registry Worker → Access**.
2. Choose **Protect this Worker behind Access**.
3. Select **All traffic** to protect production as well as previews.
4. Select the authentication policy for the people who should use the Registry.
5. Choose **Apply Access**.

Complete Zero Trust setup if prompted.

Worker-level Access protects the Worker's hostnames and routes. Everyone admitted by the policy can read and edit inventory.

## Updating a long-term deployment

1. In GitHub, open your fork’s production branch (`master`) and choose **Sync fork → Update branch**.
2. If the branch has no independent changes, GitHub can fast-forward it to upstream. If you have custom commits, review the merge and resolve any conflicts using GitHub’s standard fork and pull request workflow.
3. The updated production branch triggers Workers Builds, which runs `pnpm build` and `pnpm deploy`: D1 migrations first, then Worker deployment.
4. Check the build result and verify the deployment below. See [Backup and recovery](operations.md) for database recovery procedures.

Contribute changes upstream through ordinary GitHub pull requests. Global Registry provides no updater or sync automation.

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

Access validates the credentials before invoking the Worker. Machine mutations are audited as `service:<service_token_id>`.
