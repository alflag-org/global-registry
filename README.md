# Global Registry

Global Registry is a self-hosted infrastructure inventory and IPAM application for Cloudflare Workers and D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alflag-org/global-registry)

For **Quick deployment**, evaluation, and temporary use. For **Long-term deployment**, [fork this repository](https://github.com/alflag-org/global-registry/fork) and connect the fork to Cloudflare Workers Builds to retain the upstream relationship and use GitHub’s **Sync fork**.

## What it does

Record physical devices, virtual machines, interfaces, VLANs, prefixes, and IP addresses. Browse changes in the audit log and use the same REST API as the web interface. Global Registry does not provision or monitor infrastructure or automate providers.

- A Location contains physical Devices, VLANs, and Prefixes.
- A Virtual Machine has an optional host Device. Its location is derived from that host; moving a VM changes only its host reference.
- An Interface belongs to exactly one Device or Virtual Machine. It may have multiple IP addresses.
- A Prefix contains registered IP addresses. VLAN association is optional and must use the same Location.
- An IP address is either `assigned` or `reserved`. An absent address is free. Interface association is optional for both statuses.
- Devices and VMs can carry an external identity: `source`, `source_scope`, and `source_id`. Set all three or none. `source` is trimmed and lowercased and must match `[a-z0-9][a-z0-9._-]*`; `source_scope` and `source_id` retain their case. The triple is unique within each entity type. These values identify external objects; they do not configure integrations.

The UI provides lists, search, filters, create/edit/delete forms, related detail views, allocation, and audit browsing. The API is at `/api/v1`, its generated OpenAPI document at `/openapi.json`, and its reference page at `/docs`. All production routes require Access authentication.

## Architecture

One Cloudflare Worker serves the UI and REST API. D1 stores inventory and the audit log. Cloudflare Access authenticates requests before Worker invocation; the application accepts only the runtime-provided Access context. Every admitted identity can read and mutate inventory. There are no separate Registry accounts or roles.

## Installation

### Quick deployment

Use **Deploy to Cloudflare** above to create an independent repository copy, Worker, D1 database, and Workers Builds connection. The copy has no GitHub fork relationship or **Sync fork**; upstream updates are your responsibility.

### Long-term deployment

Fork this repository, create `global-registry-db` in Cloudflare Dashboard, and connect the fork to Workers Builds. Use `pnpm build` and `pnpm deploy` as the build and deploy commands.

Both paths use `pnpm deploy` to apply D1 migrations before publishing the Worker. See [Deployment](docs/deployment.md) for setup, build token permissions, and updates.

Your application is available at `https://<worker>.<account>.workers.dev`. Until Access is enabled, **HTTP 403 is expected** on all application routes, including the UI, API, documentation, and assets.

## After deployment

In Cloudflare Dashboard, open **Workers & Pages → your Global Registry Worker → Access → Protect this Worker behind Access → All traffic**. Select the authentication policy and choose **Apply Access**. If prompted, initialize Cloudflare Zero Trust first.

This is the only required manual configuration after deployment. Worker-level Access protects the Worker's hostnames and routes together. A custom domain is optional.

Sign in, open the UI, create a Location, and confirm its audit entry. See [Deployment](docs/deployment.md) for the complete installation verification.

## API access

People sign in through a Cloudflare Access browser session. Machine clients send `CF-Access-Client-Id` and `CF-Access-Client-Secret` with an Access Service Token permitted by a Service Auth policy. Access validates the credentials before invoking the Worker; Global Registry consumes `ctx.access` and never stores Service Token secrets.

Audit actors are `access:<user_uuid>` for people and `service:<service_token_id>` for service tokens. Missing identities are rejected.

## Local development

Use the Node.js and pnpm versions pinned in `mise.toml`:

```sh
mise install --locked node npm:pnpm
pnpm install --frozen-lockfile
pnpm types
pnpm db:migrate:local
pnpm dev
```

Open the loopback URL printed by Wrangler. The canonical configuration's `access.dev` supplies a simulated development identity through `ctx.access`; local requests use the same authentication middleware as production. No secret file or login form is needed. Keep this development server on loopback; its simulated identity is not an authentication gateway.

```sh
pnpm check
pnpm browser:install
pnpm smoke:local
pnpm deploy:dry-run:local
```

The dry-run script bundles the Worker without applying remote migrations or deploying.

## Documentation

- [Deployment](docs/deployment.md): installation and Access verification.
- [Operations](docs/operations.md): backup and recovery.
- [Architecture](docs/architecture.md): domain invariants and transaction behavior.
- [Contributing](CONTRIBUTING.md): development and checks.
- [Security policy](SECURITY.md): trust boundaries and vulnerability reporting.
