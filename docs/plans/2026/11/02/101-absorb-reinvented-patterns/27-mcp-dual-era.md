# 27 — MCP: serve the current protocol revision beside the old ones

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`mcp`), 5 (`cli`).

## Why
`MCP_PROTOCOL_VERSION` is `2025-06-18` (`packages/mcp/src/wire.ts:12`), two revisions behind. The current revision is `2026-07-28`, read from the spec on 2026-11-02: no `initialize`, version and capabilities per request in `_meta`, a mandatory `server/discover`. Its compatibility matrix says a modern client on a legacy server **fails**. Only a dual-era client falls back. An adopter's server already negotiates three versions; two more pin one.

Probe through `route.handle`, 2026-11-02:
- `initialize` offering `2025-11-25` or `2025-03-26` → `2025-06-18` both times; never echoed.
- `resources/templates/list` → `-32601`, while `initialize` advertises `resources`.
- `MCP-Protocol-Version: garbage` → 200. `Origin: https://evil.example` with a token → 200; the spec requires 403.
- `x mcp serve`: GET and DELETE on the endpoint → 404 (`packages/cli/src/cmd-mcp.ts:120`); the spec says 405.

## Files to change
- `packages/mcp/src/wire.ts:12,62` — `MCP_MODERN_VERSIONS`, `MCP_LEGACY_VERSIONS` (`2025-11-25`, `2025-06-18`, `2025-03-26`); `MCP_PROTOCOL_VERSION` becomes the newest; codes `-32020`, `-32022`.
- `packages/mcp/src/server.ts:84-89` — `METHODS`; `server.ts:175-210` — era read, version check, `server/discover`, `resources/templates/list`; `server.ts:247` — `classify` moves with them.
- `packages/mcp/src/protocol-era.ts` (new) — reads `_meta`, selects the era, stamps a result. One file, so `server.ts` stays a dispatch.
- `packages/mcp/src/transport-http.ts:230` — origin check before the token read; header validation after the parse; status per refusal.
- `packages/mcp/src/errors-transport.ts` — three new errors.
- `packages/cli/src/cmd-mcp.ts:120` — 405 with `Allow: POST` for another method on the path.
- `packages/mcp/README.md`, `packages/mcp/CLAUDE.md`, `docs/history/mcp.md`, `wiki/MCP-And-AI.md:91,255`, `wiki/Error-Codes.md`.

## Steps
1. Era is per request. `params._meta['io.modelcontextprotocol/protocolVersion']` present → modern, stateless. Absent → legacy, today's behaviour.
2. `initialize`: echo the client's version when in `MCP_LEGACY_VERSIONS`, else the newest legacy. Answered for legacy clients only.
3. Modern version not served → `-32022` with `data: { supported, requested }`, HTTP 400.
4. `server/discover` → `{ resultType, supportedVersions, capabilities, instructions?, _meta: serverInfo, ttlMs, cacheScope }`. `instructions` goes through `instructionsFor` with the caller, as `initialize` does.
5. Every modern result gains `resultType: 'complete'` and `_meta` `serverInfo`. `tools/list`, `prompts/list`, `resources/list`, `resources/read` and `resources/templates/list` gain `ttlMs: 0` and `cacheScope: 'private'`: each answer is per caller, so nothing may be shared by an intermediary. A longer `ttlMs` is a later knob, with evidence.
6. `resources/templates/list` → `{ resourceTemplates: [] }` on both eras. Empty until an adopter declares a template; no adopter does.
7. Modern over HTTP: `MCP-Protocol-Version` and `Mcp-Method` required, `Mcp-Name` for `tools/call`, `resources/read`, `prompts/get`. Compare to the body after decoding the `=?base64?…?=` sentinel. Mismatch or absence → `-32020`, 400. The check exists because a load balancer may route on a header while the server runs the body. Unknown method → `-32601` on HTTP 404.
8. `ping` stays for legacy, and is unknown to a modern request.
9. A present `Origin` other than the request's own public origin → 403, before the token is read. No `allowedOrigins` option: `POST /mcp` sends no CORS headers (`packages/cli/src/app-mcp.ts:199`), so a browser client cannot read an answer today, and non-browser clients send no `Origin`. An option arrives with the first browser client.
10. Resource not found keeps one answer for hidden and absent (`server.ts:417`, the invariant in `packages/mcp/CLAUDE.md`): `-32602` on modern, `-32601` on legacy.
11. Not shipped, and not advertised: `subscriptions/listen`, multi-round-trip input, the tasks extension, `x-mcp-header`, SSE responses. Every `listChanged` is `false` today (`server.ts:181-183`). Long work stays `.job()` plus a query, per [`90-deferred.md`](90-deferred.md). `tools/list` is already sorted (`packages/mcp/src/registry.ts:280`), as the revision asks.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MCP_PROTOCOL_UNSUPPORTED` (new) | request's version not served | resend with a version from `data.supported`. `bun run new-error-code X_MCP_PROTOCOL_UNSUPPORTED --package mcp --title '…' --cause '…' --fix '…' --status 400` |
| `X_MCP_HEADER_MISMATCH` (new) | mirrored header absent or unequal to the body | send `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` equal to the body. `--status 400` |
| `X_MCP_ORIGIN_REFUSED` (new) | cross-origin `Origin` | call from the server's own origin, or from a client that sends no `Origin`. `--status 403` |

## Tests
- `packages/mcp/src/protocol-era.test.ts` (unit): each era's answer to each method; negotiation echoes and falls back.
- `packages/mcp/src/transport-http.test.ts` (unit): each header refusal, base64 name decoded, origin refused before `resolveToken` runs (counter stays 0), same origin and no origin pass.
- `packages/mcp/src/app-security.test.ts` (unit): the three outcomes unchanged under a modern request; hidden and absent answer byte-identically.
- `packages/cli/src/cmd-mcp.test.ts` (unit): GET → 405.
- `bun test packages/mcp/src/protocol-era.test.ts`

## Semver
**Breaking, two rows.** `MCP_PROTOCOL_VERSION` is an exported constant and changes to the newest revision. `Origin` from elsewhere, once answered, is now 403. Legacy clients keep working; a modern request was answered as a legacy one by accident before.
Upgrading: "`MCP_PROTOCOL_VERSION` names the modern revision: code wanting the legacy one reads `MCP_LEGACY_VERSIONS`. A browser page on another origin calling `POST /mcp` is refused `X_MCP_ORIGIN_REFUSED`."

## Done when
- Each probe above prints the spec's answer, and a legacy `initialize` flow still passes.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
