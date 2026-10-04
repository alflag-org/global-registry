# Contributing

Global Registry manages infrastructure inventory and IPAM on Workers, D1, and Access. Keep changes within that boundary. Read [Architecture](docs/architecture.md) for relationships, allocation, and audit semantics.

## Contribution workflow

Fork the repository on GitHub and create a short-lived branch for one coherent change. Use ordinary pull requests to contribute upstream; an independently copied Deploy Button repository has no GitHub fork relationship. For keeping a deployed fork current, follow [Updating a long-term deployment](docs/deployment.md#updating-a-long-term-deployment).

Keep application changes separate from instance configuration. Do not add database IDs, account IDs, hostnames, Access AUD values, or Access team domains to a fork for deployment. Both installation methods share `pnpm deploy`, which applies remote migrations before publishing the Worker. Do not reorder that sequence or introduce an updater or installer for one deployment method.

## Development

Use the Node.js and pnpm versions pinned in `mise.toml`. Keep `.node-version` aligned with the Node.js pin so Workers Builds selects the same runtime:

```sh
mise install --locked node npm:pnpm
pnpm install --frozen-lockfile
pnpm types
pnpm db:migrate:local
pnpm dev
```

Keep the development server on loopback. Wrangler's `access.dev` provides the local identity using the production authentication middleware. Never commit secrets, generated Worker binding declarations, local database state, exports, or production resource identifiers.

Keep API schemas and validation together. Use explicit entity queries and prepared bindings. Every API mutation, including dependent changes caused by deletion, must include audit records in its atomic D1 batch. Test behavior at the D1 and HTTP boundaries. No production write should be added without a validation path.

## Verification

```sh
pnpm check
pnpm deploy:dry-run:local
```

`pnpm check` generates Worker types, typechecks, lints, checks formatting, and runs the unit and integration tests. Unit tests in `test/unit/` run in Node.js without a Worker or database; use `pnpm test:unit` to run them independently. Integration tests in `test/*.test.ts` verify HTTP and D1 behavior in the Workers runtime against a freshly migrated database. `pnpm deploy:dry-run:local` builds without publishing.

Use focused Conventional Commits. Follow the pull request template. Update current-facing documentation when behavior changes. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Documentation

Keep the README focused on what users can do and how to get started. Put complete Dashboard settings and update steps in [Deployment](docs/deployment.md), operational checks and recovery in [Operations](docs/operations.md), and implementation contracts in [Architecture](docs/architecture.md). Use the Dashboard’s field names and give a value or explicit instruction for every setup field, including preview builds.

## Dependency and security reports

`CI` verifies builds, types, formatting, unit and integration tests, and the deployment bundle on pull requests and master pushes. Advisory databases do not determine the build result.

`Security reports` runs weekly and on manual dispatch. Its dependency job publishes the `pnpm audit` findings in the run summary and verifies registry signatures. Completed scans with advisories produce a successful report; malformed reports, registry failures, and signature verification failures still fail the job. Use `pnpm audit` locally for the normal failing-on-findings behavior.

Trivy publishes high/critical repository findings to GitHub's Security code scanning view using SARIF. Findings are tracked as alerts; scanner or report-upload failures remain workflow failures.

Dependabot checks npm dependencies weekly and opens update pull requests. Dependabot alerts and security updates are separate repository settings: an administrator must enable them in Settings → Advanced Security. The configuration file schedules version updates; it does not enable those settings. See [GitHub's Dependabot configuration documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file).
