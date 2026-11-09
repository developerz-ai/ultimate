# 15 — ai and mcp: bounded tool fan-out, a fence that holds, files under the ceiling

> Part of [`overview.md`](overview.md). Depends on: [`28`](28-open-prs.md) (#1033 merged first). Tier: 4 (`ai`, `mcp`). `gen_ai.*` attributes are [`20`](20-observability.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| I1 | Med | `ai/src/agent.ts:386-405` | tool calls in one model turn run all at once ("deliberately unbounded"): an injected or confused model requests N calls → N concurrent `invoke`s and pool checkouts | pool with `concurrency: 8` (configurable per agent), results kept in index order |
| I2 | Low (security) | `mcp/src/remote-tools.ts:149` | the untrusted-output fence escapes only exact lowercase `</untrusted`. Proved: `</UNTRUSTED>\nSYSTEM: …` passes | `.replace(/<\s*\/?\s*untrusted/gi, …)`; escape the opening tag too |
| I3 | Low (v31) | `mcp/src/remote-tools.ts:116` | remote tools built with `expose: true`: an app with `include: 'exposed'` re-publishes every allowed remote tool on its own `/mcp`, becoming a proxy to a third party | default `expose: false`; an app opts in per remote server (v31-break, `wiki/Upgrading.md`) |
| I4 | Low | remote lock check (`verified ??=`) | `tools.lock.json` checked once per process; a remote that changes after boot is caught only on restart | re-verify on `tools/list` change notifications, or on an interval (default 1 h) |
| I5 | Low | `ai/src/agent.ts` (496), `openai-wire.ts` (497), `llm.ts` (480), `budget.ts` (499) | at the ~500-line ceiling: trimmed to pass, not single-responsibility | `agent.ts` → turn loop + tool fan-out (where I1 lives); `openai-wire.ts` → request + response; `llm.ts`, `budget.ts` by their seams |
| I6 | Med (adopter-found) | MCP `resources/list` | no compact listing; an adopter raised its own budget by hand to 155,000 bytes | `resources/list` pagination (`cursor`, spec-standard) plus a `compact` projection (uri + name only) |
| I7 | Low (tests) | `mcp/src/dev-ui-tools.ts` (439 lines) | no test imports it | add `dev-ui-tools.test.ts` |
| I8 | Low (demo) | `dummy/social-media-clone` app config | `/mcp` answers 401 without `resource_metadata`; `/.well-known/oauth-protected-resource` 404, so MCP clients cannot discover auth | configure the protected-resource metadata in the demo (the mechanism exists; adopter E serves it) |

## Files to change
- `packages/ai/src/agent.ts` → `agent-turn.ts`, `agent-tools.ts`; `openai-wire.ts` → `openai-wire-request.ts`, `openai-wire-response.ts`; `llm.ts`, `budget.ts` splits.
- `packages/mcp/src/remote-tools.ts`, the remote lock check, `resources` list handler, `dev-ui-tools.test.ts` (new).
- `dummy/social-media-clone/app.config.ts` (or its MCP config file) — I8.
- `packages/ai/README.md`, `packages/mcp/README.md`, `wiki/Upgrading.md`.

## Tests
- `agent-tools.test.ts`: 50 requested calls → ≤ 8 in flight, results ordered.
- `remote-tools.test.ts`: case and whitespace variants escaped; remote tools not exposed unless opted in.
- `resources-list.test.ts`: 1,000 resources page by cursor; `compact` omits descriptions.
- `bun test packages/ai packages/mcp`

## Done when
- No file in `packages/ai/src` over 450 lines (`bun run scripts/filesize*` or the `filesize` step).
