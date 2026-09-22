# Security policy

Report suspected vulnerabilities privately through the repository's GitHub security reporting channel. Include the affected revision, reproduction steps, impact, and any relevant request/response evidence without secrets or real inventory data.

## Trust boundaries

Production access is controlled by Cloudflare Access. The Worker independently validates Access JWT signatures, issuer, audience, and time claims. All identities admitted by Access can read and mutate inventory. Configure Access policies to match that authority; the application has no separate accounts or RBAC.

Audit identity comes only from verified claims. Service Token client credentials are consumed by Access, not stored or verified as local application credentials. Header spoofing must not bypass JWT verification.

Local authentication requires the development environment, explicit enablement, an unforwarded HTTP loopback request, and a private random 32-byte secret. The development UI shell contains no data and can be loaded before entering the secret; all inventory/API requests remain protected. Never expose this server using a proxy or tunnel. Production must keep local authentication disabled.

## Integrity

D1 enforces foreign keys, unique identities, Interface ownership, VLAN location consistency, and IP membership through constraints and triggers. Application parsing canonicalizes network values. Database access is a privileged operational boundary; normal mutations use the API so validation and audit cannot be omitted.

Data mutations and audit records commit together. The API offers no audit mutation endpoints, and database triggers reject audit edits. Audit logs are not a tamper-proof boundary against a D1 administrator who can alter the schema or restore the database.

The browser UI uses same-origin requests, escapes data with DOM text APIs, and rejects cross-origin mutations. Scripts and styles are served locally under a restrictive content security policy. Do not introduce credential storage, provider integrations, or unaudited write paths into this application.
