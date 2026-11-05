# 39 — Path parameters: `http.path` is the one spelling

> Part of [`overview.md`](overview.md). Depends on: [`26-api-read-contract.md`](26-api-read-contract.md) (mount cuts in `contract-diff`). Tier: 0 (`core`), 2 (`http`, read-only), 3 (`action`, `query`), 4 (`manifest`), 5 (`cli`).

## Why
A public `/v1` is `POST /v1/orders/:id/refund` and `GET /v1/orders/:id`. Today it cannot be a projection: `bearer-mount.ts:69` and `http-path.ts:37` both refuse parameters, `mountedPath` (`:86`) gives `/v1/refund-order`. Two adopters and one other API wrote their own; one `/v1` is 792 LOC of routes re-implementing the policy, idempotency and schema the action already has.
Recorded objection: a third URL spelling beside `http.path` and `runtime.routes` (axiom 1). Answer: no third spelling and no new mount option. `http.path` already pins an action's URL; it grows parameters and a method, `query` gains the same field, and the mount serves what it has always served.

## Decisions
| Question | Answer |
|---|---|
| Mount change | **none.** `mountedPath(prefix, '/orders/:id/refund')` already answers `/v1/orders/:id/refund` (`:90`), and the router already matches `:param`. `bearerMount`'s `PREFIX` stays parameter-free |
| `runtime.routes` | stays what it is: other wire formats, per the owner's rule |
| A pin's meaning | still "where this is served", so `api/` stays projections only |
| Parameter source | a `:name` must be a required top-level key of `input:`, else the existing `X_ACTION_HTTP_PATH_INVALID` at seating. Value merged into input before `invoke`, so policy, row and idempotency see one object |
| Path versus body disagree | refused 400 `X_HTTP_PATH_INPUT_CONFLICT`. Path winning silently would let a policy read one id and a handler another |
| Method | `http: { path, method }`, action: `POST` (default), `PUT`, `PATCH`, `DELETE`; query: `GET`. `X_ACTION_PATH_DUPLICATE` keys on method and path, so REST's two verbs on one URL are legal |
| Decoding | `route-path.ts`'s one decode. A segment with `/` stays one param |
| Typed clients | `action.client()` substitutes from input, `encodeURIComponent`. `rpc()` reaches a pin by name in a browser through the `ultimate-pins` stamp (wave 5b); a server takes `.client()`; a miss stays `X_CONTRACT_DRIFT` |
| `derivePath`, `actionHttpPath` | parameterised: require `params` and fill, or refuse with the path invalid code. A deprecation's `replacedBy` naming one is `X_ACTION_DEPRECATION_INVALID`: a `Link` cannot carry a template |
| OpenAPI | `:id` → `{id}`, `in: path, required`, the key removed from the published request body and from query parameters. Operation key follows `method`, not fixed `post` |
| Path style | a pin outranks `pathStyle`, as it does today |

## Files to change
- `packages/action/src/http-path.ts:28-37,89-108` — the option, new pattern, seating check, `fillPath`.
- `packages/action/src/http.ts:100-130,200` — merge params, conflict refusal, `method`. `errors-http.ts`.
- `packages/action/src/http.ts:225-253`, `openapi.ts`, `openapi-complete.ts:264`, `contract-test.ts:122` (`entry['post']` reads the declared method) — `{id}`, parameters, operation key.
- `packages/action/src/client.ts`, `facade.ts:39` — substitution in `.client()`. `registry.ts` — path key.
- `packages/query/src/http.ts:66,138`, `openapi.ts:87-101,149,183`, `facade.ts`, `client.ts` — `http: { path }`, same check, same merge.
- `packages/core/src/route-path-template.ts` (new) — `templateParams`, `fillTemplate`, `toOpenApiPath`: action and query cannot share otherwise. `packages/core/src/client-paths.ts` untouched.
- `packages/manifest/src/schema.ts:167,191`, `sources.ts`, `diff-operations.ts:75` — `ActionFact.http?`, `QueryFact.http?` (`{ path, method }`), written only when pinned. A changed `method` or `path` is `breaking`, so `contract-diff` sees it.
- `packages/cli/src/api-routes.ts:35`, `app-openapi.ts:73` — no change expected; covered by tests.
- `examples/dummy/apps/web/api`, `posts` — one parameterised pin behind its mount. `wiki/Actions.md` (and whichever page holds `apiMounts`; the page list has no API page), `wiki/Queries-And-Live-Queries.md`, `wiki/Error-Codes.md`, `packages/{action,query,http}/{README,CLAUDE}.md`.

## Steps
1. `bun run new-error-code` below.
2. Template helpers in core, pure, no imports beyond `core`.
3. Action, then query, then OpenAPI, then client.
4. Delete the bearer-mount header's implication that paths are flat: comment only.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_HTTP_PATH_INPUT_CONFLICT` (400) | body or query names a key with a different value than the path | send one value; omit the key from the body. `bun run new-error-code X_HTTP_PATH_INPUT_CONFLICT --package core --title '…' --cause '…' --fix '…' --status 400`: in `core`, because `query` borrowing an `action` code is a sideways import |
| `X_ACTION_HTTP_PATH_INVALID` (existing) | also: `:name` not a required string input key, an unknown method | add the key to `input:`, or correct the template |
| `X_ACTION_DEPRECATION_INVALID` (existing) | also: `replacedBy` naming a parameterised pin | name a static successor, or none |

## Tests
- `packages/action/src/http-path-params.test.ts` (unit): `POST /orders/:id/refund` reaches the handler with `input.id`; a policy `row` loader sees it; path and body disagree 400; a missing key refused at seating; encoded `a%2Fb` stays one value; two verbs on one URL coexist.
- `packages/http/src/bearer-mount.test.ts`: a parameterised route under a prefix, scope cut still 404, catch-all still 401, no change to `bearer-mount.ts` proved by no diff.
- `packages/action/src/openapi-path-params.test.ts`: `{id}`, parameters, body minus key; every static action byte-identical.
- `packages/query/src/http-path-params.test.ts`: `GET /orders/:id`, `in: path`.
- `packages/manifest/src/diff-registries.test.ts`: `POST` to `PUT` on a pin is breaking; a static action's fact has no `http` key.
- `packages/action/src/client-path.test.ts`: `.client()` substitutes and encodes. `bun test packages/action/src/http-path-params.test.ts`

## Semver
Minor. A refused declaration becomes legal; every static action's bytes are unchanged; a `DELETE` is new surface only for an action that asks.

## Done when
- A reference-app action answers `POST /v1/posts/:postId/publish` with a bearer token, one declaration, no route file.
- `git diff packages/http/src/bearer-mount.ts` shows a comment at most. No new option on `bearerMount`.
- `grep -rn "'/v1" packages/action packages/query` answers nothing: nothing special-cases a prefix.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.

## Risks
- CSRF, audit and rate-limit keys read `route.path` as a pattern, never the concrete URL (`http/CLAUDE.md`): holds, since a template is a pattern.
- A pinned route still answers at its own path with the cookie authenticator as well as under the mount. Same as today's pins, and policy still runs. Stated in `wiki/Actions.md`.
