# Operations

Manage deployments, Access policies, and the Registry’s D1 database in your Cloudflare account. Workers Builds runs application updates; D1 provides native export and recovery mechanisms. Schedule and retain backups according to your operational requirements.

## Deployments and updates

Follow [Deployment](deployment.md) for installation and updates. A long-term installation receives upstream changes through GitHub **Sync fork → Update branch**; an independent Deploy Button copy requires manual upstream integration. Both trigger Workers Builds on production-branch pushes and use `pnpm deploy` to apply migrations before publishing the Worker.

In build logs, confirm that pending migrations succeeded, the Worker has its D1 binding, and the deploy command completed. If migration fails, deployment stops. A successful migration remains applied even if the later Worker deployment fails; inspect the failure and retry the deployment after correcting it. Redeploying an older Worker version does not undo database migrations, so verify schema compatibility before rolling back code.

For a fork, keep the production branch at `master`, the project name at `global-registry`, and preview builds disabled for the documented production setup. No build variables or separately prepared API token are required for the normal import flow. If migrations fail due to permissions, use the [D1 permission troubleshooting steps](deployment.md#troubleshoot-d1-permission-errors).

After deployment, use the [verification steps](deployment.md#verify-deployment) to check Access, the UI, API documentation, and an audited mutation. Build success confirms publishing; it does not verify Access policies or application behavior.

## Backups

Treat exports as sensitive inventory, including audit identities. Keep them outside the source repository, restrict access, and use your organization's backup retention policy. Follow Cloudflare's [D1 export/import documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for the selected database. Periodically validate backups in an isolated database before relying on them.

A full schema-and-data export already contains the schema: do not apply the initial migration before importing it. Check table counts, foreign keys, representative relationships, IP allocations, audit snapshots, and migration state. For a new installation, use a fresh database. For recovery, restore a Global Registry backup and verify that its schema and migration ledger match the Worker version you intend to run. Unrelated application schemas are not supported.

## Time Travel

Use D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) controls for the deployed database. Recovery availability and retention depend on Cloudflare's current plan and database limits.

Stop client writes and preserve current data before restoring. Verify inventory relationships, allocations, audit history, and client behavior before resuming writes. Restoring changes both inventory and audit state; it is an operator recovery action rather than an API mutation. Direct database writes bypass application validation and audit and are not a normal inventory workflow.

After restoring, verify Worker/schema compatibility before triggering another production build. The build applies any migrations not recorded in the restored migration ledger. Keep Access protection in place throughout recovery.
