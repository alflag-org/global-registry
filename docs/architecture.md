# Architecture

Global Registry is a source of truth for infrastructure inventory and IPAM. The request path is Cloudflare Access → Worker → D1. The Worker serves the web UI and REST API; it does not call infrastructure providers.

## Code responsibilities

- `src/api`: runtime Zod validation, OpenAPI route declarations, HTTP errors, and browser request protections.
- `src/auth`: Access JWT signature/issuer/audience/time validation and the separate local authentication boundary.
- `src/db`: explicit entity SQL, related detail queries, and atomic audit/mutation batches.
- `src/ipam`: IP parsing, canonicalization, range arithmetic, and allocation.
- `src/ui`: a same-origin browser client; forms consume the generated OpenAPI input schemas.

The model has eight tables: `locations`, `devices`, `virtual_machines`, `interfaces`, `vlans`, `prefixes`, `ip_addresses`, and `audit_log`. The migration is seed-free. D1 maintains its own migration ledger.

## Relationships and validation

Devices represent physical equipment with a non-empty role string, such as server, router, switch, storage, or appliance. There is no separate role registry. VMs are independent identities with nullable host Device references. VM location is derived through the host. Interfaces require exactly one owner, enforced by a SQL check, and names are unique within each owner.

External source triples are complete or entirely null and unique per Device/VM table. A VLAN VID is unique within a Location and ranges from 1 to 4094. Composite foreign keys enforce that a Prefix and its VLAN share a Location, including when either is edited.

IP/CIDR parsing uses `ipaddr.js`. IPv4 input requires four decimal octets. IPv6 is compressed and lowercased; zone identifiers are rejected. IPv4-mapped IPv6 literals normalize to IPv4 to avoid duplicate identities; mapped CIDRs require a length of at least 96 and normalize to the equivalent IPv4 network. Prefixes clear host bits before storage. IPv4 and IPv6 otherwise remain separate families.

Prefix family, prefix length, fixed-width hexadecimal range bounds, and IP address sort keys are derived columns written by the application. They support indexed comparisons without enumerating address space. D1 triggers reject address membership violations and edits that move a Prefix away from its registered addresses. API validation checks the canonical input; raw database writers must preserve derived columns and are not a supported inventory mutation interface.

## Allocation

`POST /api/v1/prefixes/{id}/allocate` returns a newly assigned IP. It considers existing address rows across all overlapping Prefixes and every more-specific Prefix contained by the target. It sorts occupied intervals and jumps over them, so an IPv6 subnet is never expanded into individual rows.

The lowest available address is selected. IPv4 network/broadcast addresses are excluded for lengths below 31. Both addresses in /31 and the one address in /32 are eligible. IPv6 has no broadcast exclusion. Explicit IP creation may register any address inside its Prefix, including addresses excluded from automatic allocation.

The insertion rechecks the current parent CIDR and child-prefix exclusions in SQL. Global IP uniqueness is the final concurrency boundary. Only address uniqueness collisions retry, for at most five attempts. A changed Prefix relationship or exhaustion returns 409. Clients may retry conflicts after refreshing state. Allocation has no external locks.

## Mutations, deletion, and audit

Every successful API mutation includes its audit insert in the same D1 batch. A failed batch rolls back both. Updates compare the previously read row in their SQL predicate to reject concurrent overwrites. Audit snapshots describe committed entity fields; derived range columns are excluded. Audit IDs combine an application-generated UUID with the entity ID, allowing one cascading statement to log multiple rows without collisions. Database triggers prohibit audit updates and deletes.

Deleting a Device deletes its Interfaces, clears the host reference on its VMs, and retains IP addresses with cleared interface references. Deleting a VM deletes its Interfaces and retains their IPs. Deleting an Interface detaches its IPs. Each dependent change is audited in the same batch and updates timestamps where applicable.

A Prefix containing IP rows cannot be deleted. A VLAN referenced by a Prefix cannot be deleted. A Location referenced by a Device, VLAN, or Prefix cannot be deleted. Delete the dependent entries explicitly first. IP deletion is a release and records the `release` action; automatic allocation records `allocate`.

## API and UI

List endpoints return `{ "items": [], "total": 0 }`. `limit` defaults to 50 and is capped at 200; `offset` defaults to zero. Lists use creation time and ID for deterministic ordering. Applicable filters and strict request bodies are defined alongside route registration and appear in OpenAPI. Errors consistently contain `code` and `message`: 400 for invalid requests, 401/403 for authentication/origin rejection, 404 for missing entities, and 409 for uniqueness, relationship, or concurrency conflicts.

The UI uses the REST API, including for relationship selections and all writes. Device, VM, and Prefix details show related records. No free IP rows are generated for display. Security headers disallow framing and restrict scripts, styles, and connections to the same origin. Browser mutations reject cross-origin requests; non-browser clients need no Origin header.
