# 39 — Prompt-cache rows an app can declare

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`ai`).

## Why
`PROMPT_CACHE_RULES` (`ai/src/prompt-cache.ts:130`) is a module constant naming four hosts, and "unknown endpoints get NOTHING". The rule is right, because a field a server has never heard of can be a 400. But it leaves no way to state what the app knows. Probe: `promptCacheRule('openai', 'https://llm.internal/v1', 'family/x')` answers `{ marks: 'none', session: 'none' }`, so a company gateway fronting a marking family pays a full-price prefix on every turn, and the only repair is a fork. The reverse also: `promptCacheRule('anthropic', 'https://proxy.internal', 'x')` answers `blocks`, so a proxy that rejects `cache_control` has no way out except a global `'off'` on each call.
`docs/history/ai.md`: apps bring their own models and providers. A self-hosted gateway is exactly that case. The file's own words: "a new host or model family is a row".

## Decisions
| Question | Answer |
|---|---|
| Second switch beside `GenerateRequest.promptCache`? | no. That one asks whether to cache; this one says how this endpoint is told. It feeds the same lookup |
| Shape | `promptCache: { rules: [{ model, marks, session }] }` on `anthropicProvider()` and `openAiProvider()`. A row without `wire` and `host`, since the provider is both |
| Precedence | provider rows, first match, then the module table, then `NO_RULE`. Rows are data, never an `if`, as today |
| A mark the wire cannot speak | `marks: 'parts'` on the Messages wire, or `'blocks'` on chat-completions: refused at construction, `X_AI_REQUEST_INVALID`, the code `provider.ts:256` already uses for a factory mistake |
| Budget estimate | `marksPromptCache` (`provider.ts:338`, `openai-provider.ts:112`) reads the same rule, so a marked endpoint reserves the write rate, and `none` does not |
| Longer TTL | out. `CACHE_MARK` is the 5-minute rate, and `costOf` prices that rate; a 1-hour mark needs a price row first, and is its own change |
| Cap | at most 3 marks, a caller's own counted first: unchanged, enforced downstream of the rule |
| Vendor neutrality | a row names a model prefix the app registered. `vendor-neutral.test.ts` still holds: no data ships |

## Files to change
- `packages/ai/src/prompt-cache.ts:151-164` — `promptCacheRule(wire, baseUrl, model, rows?)`; `ProviderCacheRow` type.
- `packages/ai/src/provider.ts:231,338` — option, screen, pass through; `prompt-cache-blocks.ts` caller.
- `packages/ai/src/openai-provider.ts:37,112`, `openai-body.ts:41` — same. `sessionHeaders` reads the resolved row.
- `packages/ai/src/index.ts` — type export.
- `packages/ai/README.md`, `packages/ai/CLAUDE.md` (provider prompt caching section), `wiki/MCP-And-AI.md` or `wiki/Agents.md` caching section, `docs/history/ai.md`. No `examples/dummy` use: an endpoint fact. Add a line to the scaffold's AI comment only if one names the option.

## Steps
1. Failing tests first.
2. `rows` is an optional last parameter, so the exported function's existing callers are unchanged.
3. Screen at construction: `marks` within what the wire speaks; `session` within what the wire carries (`x-session-id`, `prompt_cache_key` on chat-completions; `none` on Messages); `model` a string.
4. Resolve per request in `body()`, with no caching of the row across models.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_AI_REQUEST_INVALID` (existing) | a provider row names marks or a session carrier its wire lacks | `blocks` on the Messages wire, `parts` on chat-completions, `none` on either |

## Tests
- `packages/ai/src/prompt-cache.test.ts`: the two probes, then with a row each flips; first match wins; model prefix respected; table still reached with no row matching; `NO_RULE` still the last answer.
- `packages/ai/src/provider-parity.test.ts`: a marking row produces the same marks the table's row does on that wire, byte for byte; `none` sends no field.
- `packages/ai/src/gateway-budget*.test.ts`: `marksPromptCache` follows the row, reserving at the write rate.
- `packages/ai/src/vendor-neutral.test.ts`: unchanged, green. `bun test packages/ai/src/prompt-cache.test.ts`

## Semver
Minor. Optional option and parameter.

## Done when
- A gateway at an unnamed host marks prefixes with one provider option and no fork.
- A proxy on the Messages wire can decline marks without touching any call.
- `bun run verify` green.
