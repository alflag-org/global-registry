# Security policy

## Supported boundary

Production is designed to run behind Cloudflare Access. The shared configuration has unset deployment values, disables workers.dev and preview exposure, and fails closed until an operator supplies the Access team domain, audience, D1/R2/Queue identifiers, scheduled maintenance, and an active Actor mapping. Provider credential values are outside this registry; the application stores only uppercase credential references.

The production overlay must keep `ENVIRONMENT=production` and `ALLOW_LOCAL_AUTH=false`. Do not place credentials, private keys, Access assertions, raw production exports, or personal data in source, configuration, logs, fixtures, issues, or documentation.

## Authentication and authorization

The Worker verifies the Cloudflare Access issuer, audience, RS256 signature, expiration, optional not-before claim, and canonical principal identity. A human principal is represented as `access:<sub>` and a service principal as `service:<common_name>`; email is not an identity fallback. The verified identity must map to an active Actor before using the registry API or main UI. Actor role checks authorize operations, and revision checks protect concurrent updates.

Mutations require the JSON media type, a bounded streamed body, valid JSON limits, and same-origin or compatible Fetch Metadata conditions. Errors use structured codes and request IDs; logs redact unexpected error details. Writes use prepared statements. The D1 schema enforces foreign keys, revisions, append-only audit/history records, active-admin safeguards, and fencing for operation locks.

## Development-only local authentication

Local authentication is permitted only when `ENVIRONMENT=development` and `ALLOW_LOCAL_AUTH=true`. The supported `mise run dev` task runs Wrangler on `127.0.0.1`; never expose this mode through a public bind or tunnel.

Local authentication is accepted only for an HTTP loopback URL with an exact `Host` match and no URL credentials. It also requires a valid `LOCAL_AUTH_SECRET` and a canonical local Actor identity. The secret must be a fresh 64-character lowercase hexadecimal value generated with `openssl rand -hex 32`; the checked-in example intentionally leaves it unset. The client supplies the secret through `x-global-registry-dev-secret` and may supply the identity through `x-global-registry-dev-identity`. The only trusted forwarding signal is one exact `cf-connecting-ip: 127.0.0.1` marker. Other forwarding context and duplicate or combined markers fail closed.

## Security controls and operational boundary

OpenAPI is served only after authentication. `/docs` uses repository-hosted assets and a self-only Content Security Policy without a CDN or `unsafe-inline`. JSON values, request bodies, export snapshots, and SQL recovery inputs are bounded and validated. Exports contain credential references, not credential values, and R2 completion is fenced by the D1 revision and claim token.

These controls do not replace deployment acceptance. Operators must validate the target Access policy and cookie behavior and exercise D1 concurrency plus Queue/R2 partial-failure recovery in the deployed environment.

## Private reporting

Report suspected vulnerabilities privately to the repository maintainers before public disclosure. Include a concise reproduction, the affected route or component, expected and observed behavior, and only the evidence needed to reproduce it. Do not include credential values, private keys, Access assertions, raw production exports, or personal data. Do not use a public issue for an undisclosed vulnerability.
