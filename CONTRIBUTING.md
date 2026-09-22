# Contributing

Global Registry manages infrastructure inventory and IPAM on Workers, D1, and Access. Keep changes within that boundary. Read [Architecture](docs/architecture.md) for relationships, allocation, and audit semantics.

## Development

Use the Node.js and pnpm versions pinned in `mise.toml`:

```sh
mise install --locked node npm:pnpm
pnpm install --frozen-lockfile
pnpm types
pnpm db:migrate:local
pnpm dev
```

Configure the development secret as described in [README](README.md). Never commit local secrets, Worker binding declarations, local database state, exports, or environment identifiers.

Keep API schemas and validation together. Use explicit entity queries and prepared bindings. Every API mutation, including dependent changes caused by deletion, must include audit records in its atomic D1 batch. Test behavior at the D1 and HTTP boundaries. No production write should be added without a validation path.

## Verification

```sh
pnpm check
pnpm browser:install
pnpm smoke:local
pnpm deploy:dry-run:local
```

`pnpm check` generates Worker types, typechecks, lints, checks formatting, and runs tests in the Workers runtime against a freshly migrated D1 database. `pnpm smoke:local` applies local migrations and exercises actual browser CRUD and allocation through a loopback Worker. `pnpm deploy:dry-run:local` builds without publishing.

Use short-lived branches and focused Conventional Commits. Follow the pull request template. Update current-facing documentation when behavior changes. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Dependency and security reports

`CI` verifies builds, types, formatting, tests, browser behavior, and the deployment bundle on pull requests and master pushes. Advisory databases do not determine the build result.

`Security reports` runs weekly and on manual dispatch. Its dependency job publishes the `pnpm audit` findings in the run summary and verifies registry signatures. Completed scans with advisories produce a successful report; malformed reports, registry failures, and signature verification failures still fail the job. Use `pnpm audit` locally for the normal failing-on-findings behavior.

Trivy publishes high/critical repository findings to GitHub's Security code scanning view using SARIF. Findings are tracked as alerts; scanner or report-upload failures remain workflow failures.

Dependabot checks npm dependencies weekly and opens update pull requests. Dependabot alerts and security updates are separate repository settings: an administrator must enable them in Settings → Advanced Security. The configuration file schedules version updates; it does not enable those settings. See [GitHub's Dependabot configuration documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file).
