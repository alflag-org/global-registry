# Backup and recovery

Global Registry uses D1's native export and recovery mechanisms. The application has no backup scheduler, export endpoint, or object-storage dependency. Manage the database created by Deploy to Cloudflare in your Cloudflare account.

## Backups

Treat exports as sensitive inventory, including audit identities. Keep them outside the source repository, restrict access, and use your organization's backup retention policy. Follow Cloudflare's [D1 export/import documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for the selected database. Periodically validate backups in an isolated database before relying on them.

A full schema-and-data export already contains the schema: do not apply the initial migration before importing it. Check table counts, foreign keys, representative relationships, IP allocations, audit snapshots, and migration state. This installation targets a fresh database; importing an older application's schema is not supported.

## Time Travel

Use D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) controls for the deployed database. Recovery availability and retention depend on Cloudflare's current plan and database limits.

Stop client writes and preserve current data before restoring. Verify inventory relationships, allocations, audit history, and client behavior before resuming writes. Restoring changes both inventory and audit state; it is an operator recovery action rather than an API mutation. Direct database writes bypass application validation and audit and are not a normal inventory workflow.
