# Security policy

Report suspected vulnerabilities privately through the repository's GitHub security reporting channel. Include the affected revision, reproduction steps, impact, and any relevant request/response evidence without secrets or real inventory data.

## Trust boundaries

Cloudflare Access authenticates requests before Worker invocation. Global Registry trusts only the runtime-provided `ctx.access` and obtains identity through `ctx.access.getIdentity()`. All routes, including the UI, API, documentation, and assets, reject missing Access context with HTTP 403. HTTP headers alone never authenticate a request.

All identities admitted by Access can read and mutate inventory. Configure Access policies to match that authority; the application has no separate accounts or RBAC. Worker-level Access should protect all traffic.

Audit identity uses `access:<user_uuid>` for people and `service:<service_token_id>` when Access identifies service authentication. Missing or malformed identity fields are rejected. Service Token credentials are consumed by Access and must never be stored in Registry data.

Local development uses Wrangler's `access.dev` simulation and the same authentication code path as production. There is no application-managed local authentication or secret. Keep the simulated development server on loopback and do not expose it through a tunnel or proxy. Wrangler's development identity does not configure production Access.

## Integrity

D1 enforces foreign keys, unique identities, Interface ownership, VLAN location consistency, and IP membership through constraints and triggers. Application parsing canonicalizes network values. Database access is a privileged operational boundary; normal mutations use the API so validation and audit cannot be omitted.

Data mutations and audit records commit together. The API offers no audit mutation endpoints, and database triggers reject audit edits. Audit logs are not a tamper-proof boundary against a D1 administrator who can alter the schema or restore the database.

The browser UI uses same-origin requests, escapes data with DOM text APIs, and rejects cross-origin mutations. Scripts and styles are served locally under a restrictive content security policy. Do not introduce credential storage, provider integrations, or unaudited write paths into this application.
