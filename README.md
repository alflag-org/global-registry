# Global Registry

Global Registry is a lightweight infrastructure inventory and IP address management system built on Cloudflare Workers and D1.

It records physical devices, virtual machines, interfaces, VLANs, prefixes, and IP addresses. It does not provision, change, or monitor infrastructure. External automation reads and writes the same REST API used by the web interface.

## Architecture and domain

Cloudflare Access protects a single Worker serving the UI and REST API. D1 stores inventory and an append-only audit log. No additional Cloudflare storage or messaging components are required.

- A Location contains physical Devices, VLANs, and Prefixes.
- A Virtual Machine has an optional host Device. Its location is derived from that host; moving a VM changes only its host reference.
- An Interface belongs to exactly one Device or Virtual Machine. It may have multiple IP addresses.
- A Prefix contains registered IP addresses. VLAN association is optional and must use the same Location.
- An IP address is either `assigned` or `reserved`. An absent address is free. Interface association is optional for both statuses.
- Devices and VMs can carry an external identity: `source`, `source_scope`, and `source_id`. Set all three or none. `source` is trimmed and lowercased and must match `[a-z0-9][a-z0-9._-]*`; `source_scope` and `source_id` retain their case. The triple is unique within each entity type. These values identify external objects; they do not configure integrations.

The UI provides lists, search, filters, create/edit/delete forms, related detail views, allocation, and audit browsing. The API is at `/api/v1`, its generated OpenAPI document at `/openapi.json`, and its reference page at `/docs`. All production routes require Access authentication.

## Local development

Requirements: the Node.js and pnpm versions pinned in `mise.toml`.

```sh
mise install --locked node npm:pnpm
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Set `LOCAL_AUTH_SECRET` in `.dev.vars` to the generated value. Then:

```sh
pnpm db:migrate:local
pnpm dev
```

Open the loopback URL printed by Wrangler and enter the local secret. The browser keeps it in tab-scoped session storage and sends it with API requests. This mode accepts only unforwarded HTTP loopback requests and fails closed outside the development environment. Do not expose the development server through a tunnel or proxy.

For local API requests, supply `x-global-registry-dev-secret`. Production clients instead authenticate through Cloudflare Access; see [Deployment](docs/deployment.md).

```sh
pnpm check
pnpm browser:install
pnpm smoke:local
pnpm deploy:dry-run:local
```

## Deployment and recovery

Use a **fresh D1 database** and apply all migrations in order. This schema does not upgrade a previous Global Registry installation. No inventory data is seeded. Do not apply it over an older schema or edit D1's migration ledger to disguise an old database as a fresh one.

See [Deployment](docs/deployment.md) for Access, Service Tokens, and Worker configuration; [Operations](docs/operations.md) for D1 export and recovery; and [Architecture](docs/architecture.md) for invariants and transaction behavior.
