# Architecture

Cloudflare Access authenticates requests before they reach the Worker. The Worker serves the web UI and REST API; D1 stores inventory and audit history. The UI uses the same API as external clients.

## UI language

The UI uses the browser language unless `localStorage.registry-lang` contains `en` or `ja`. Invalid preferences and unavailable browser storage fall back to the browser language. Initial shell labels and the language selector remain hidden until the client applies that language, preserving their layout. The localized shell becomes visible before API data loads.

## Data model

- Locations group Devices, VLANs, and Prefixes.
- A Virtual Machine may have a host Device. Its location comes from that host.
- Each Interface belongs to one Device or Virtual Machine.
- Each IP address belongs to a Prefix and may be attached to an Interface. Registered addresses are assigned or reserved; unregistered addresses are free.
- A Prefix and its associated VLAN must belong to the same Location.

IP addresses are globally unique and must remain inside their Prefix. Addresses and prefixes are normalized before storage. Allocation finds the lowest available address while excluding occupied addresses and more-specific prefixes, without enumerating the subnet.

## Data integrity and audit

D1 constraints and triggers enforce relationships and uniqueness. Inventory changes and their audit records commit in the same database batch; a failure rolls back both. Updates reject concurrent overwrites.

Deleting a Device or Virtual Machine removes its Interfaces but retains IP addresses, clearing their interface references. Deleting a Device also clears its VMs’ host references. These dependent changes are audited. A Location, VLAN, or Prefix with references that prevent deletion must have those references removed first.

Normal writes go through the API. Direct database changes bypass application validation and audit. Audit records cannot be edited through the application; a database administrator can still alter the schema or restore data.

## Authentication

The application trusts the Worker runtime’s `ctx.access` identity. Missing or malformed identities are rejected. Every identity allowed by Access can read and edit inventory; the application has no separate accounts or roles.

Audit records identify people by Access user ID and machine clients by Service Token ID. Service Token credentials are handled by Access and are not stored by the application. Local development uses Wrangler’s Access identity simulation.
