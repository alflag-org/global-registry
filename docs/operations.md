# Backup and recovery

Global Registry uses D1's native export and recovery mechanisms. The application has no backup scheduler, export endpoint, or object-storage dependency.

## SQL export

Export the selected database with a private Wrangler configuration:

```sh
pnpm exec wrangler d1 export DB --remote \
  --config /absolute/private/wrangler.jsonc \
  --output /absolute/private/registry-backup.sql
```

Treat exports as sensitive inventory, including audit identities. Keep them outside this repository, restrict access, and use your organization's existing backup retention/storage policy. Check the command exit status and periodically test a restore into a separate database before relying on a backup.

For a restore rehearsal, create a separate empty D1 database, reference it in a private test configuration, and import the export:

```sh
pnpm exec wrangler d1 execute DB --remote \
  --config /absolute/private/restore-test.jsonc \
  --file /absolute/private/registry-backup.sql
```

Do not apply the initial schema before importing a full schema-and-data export. Check table counts, `PRAGMA foreign_key_check`, representative inventory/API queries, and audit snapshots against the source. Confirm the D1 migration state before using migration commands on the restored database. An export from an older Global Registry schema cannot be imported into this installation.

## Time Travel

Inspect D1 recovery availability before selecting a restore point:

```sh
pnpm exec wrangler d1 time-travel info DB --config /absolute/private/wrangler.jsonc
```

Stop client writes and export current data before restoring. Use the selected timestamp or bookmark with `wrangler d1 time-travel restore`, then verify relationships, allocations, audit history, and client behavior before resuming writes. Restoring changes both inventory and audit state; it is an operator recovery action rather than an API mutation.

Retention and recovery availability depend on the Cloudflare plan and database. Consult the current [D1 export/import documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) when performing recovery.
