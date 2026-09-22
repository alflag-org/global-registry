---
name: testing-global-registry-ui
description: How to run and UI-test the Global Registry worker locally (dev auth, wrangler dev, golden-path flow)
---

# Testing Global Registry UI locally

## Dev server

- No system node: `export PATH=$HOME/.local/opt/node/bin:$PATH` (node + pnpm via corepack live there).
- `pnpm dev` starts wrangler dev on `http://127.0.0.1:8787`. If an old `pnpm dev` is already running and may predate the commit under test, kill the wrangler/workerd processes and restart — stale workers serve stale code.
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/` should be 200.

## Auth (dev mode)

- `.dev.vars` at repo root holds `LOCAL_AUTH_SECRET` (64-hex) and `LOCAL_ACTOR_IDENTITY`.
- First page load in a fresh tab shows a "Local development access" dialog — the worker returns 401 for `/api/v1/*` and `/openapi.json` without the secret. Paste `LOCAL_AUTH_SECRET` into the dialog once; it is kept in `sessionStorage` as `registry-local-secret` for that tab only.
- For shell/API checks use header `x-global-registry-dev-secret: <LOCAL_AUTH_SECRET>`.

## UI golden path (one continuous flow)

1. `/` — count cards per entity.
2. `/{entity}/new` — OpenAPI-driven create form; ref fields render as selects populated from list endpoints; required fields marked `*`.
3. Detail `?edit` — PATCH form prefilled with existing values.
4. Prefix detail `?allocate` — allocates lowest free IP, optional interface/dns binding; redirects to `/ip-addresses/{id}`.
5. Device detail "Add interface" → `/interfaces/new?device_id=<id>` (presets the device select). Interface detail "Register IP address" presets `interface_id`.
6. Delete button → `confirm()` dialog → DELETE; FK RESTRICT violations surface as error banner "A unique value or relationship conflicts with existing data." (409). Deleting a device cascades its interfaces; deleting a prefix/device detaches dependent IPs (audit `update`).
7. `/audit-log` — filterable by entity_type/entity_id/actor/action; actions: create/update/delete/allocate/release.
8. `/docs` — OpenAPI explorer (one `<details>` per operation).

## Known UI quirk

- Create-button label strips only a trailing "s" (`names[path].replace(/s$/,'')`), producing "Create Prefixe" / "Create IP Addresse". Pre-existing, not a refactor regression.

## Useful assertions

- Security: `curl -sI /` should show CSP `default-src 'none'`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, `Cache-Control: no-store`. POST with non-JSON content-type → 400 `Use application/json.`; cross-site Origin → 403 `cross_site_mutation`; malformed JSON → 400 (not 500).
- Update guard: editing a prefix CIDR to exclude an allocated IP → 400 "Prefix must contain every registered IP address."

## Devin Secrets Needed

- none (all auth material is local `.dev.vars`)
