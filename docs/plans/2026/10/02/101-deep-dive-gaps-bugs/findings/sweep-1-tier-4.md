# Sweep 1 — tier 4 correctness

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify`.
> CONFIRMED = a probe ran. PLAUSIBLE = from reading only.
> Line numbers in `hive`, `rag`, `evals`, `scorers`, `notify`, `manifest` come from comment-stripped
> listings — approximate. **Exact citations, two refuted lows (`diff-routes`, `channel-mail`) and the
> narrowed rows are in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — that file wins.**

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/ai/src/hive.ts:72` | `hive()` roots its ledger in `currentBudget() ?? new BudgetLedger({ limits: {} })`; never consults `gateway.callLedger()` | `createGateway({ budget: { request: 10 } })`: a direct `llm()` is refused `X_AI_BUDGET_EXCEEDED`; the same `llm()` as a hive member ran twice (`tokens: 40`) | CONFIRMED | root the ledger as `llm.ts:262-266` and `agent.ts:274-278` do | `packages/ai/src/hive.test.ts` |
| 2 | `packages/notify/src/fanout.ts:130` | audience never deduplicated; step name is `deliver:<channel>:<recipient.id>` | `recipients: () => [u1, u2, u1, u3]` → `X_STEP_DUPLICATE` after u1, u2; u3 never notified; the retry fails identically | CONFIRMED | dedupe by `id` inside the `open` step (`fanout.ts:30-33`); `fanout-digest.ts:50,56` names steps the same way | `packages/notify/src/fanout.test.ts` |
| 3 | `packages/mail/src/job.ts:8,14,15,16` | `mailMessageSchema` types `to` / `cc` / `bcc` / `replyTo` as `t.email`; `renderMessage`, `assertHeaderSafe`, every driver accept the display form | `send(mail, data, { to: 'Jane Doe <jane@x.test>' })` → `{ queued: true }`, then the worker's `handle.parse` rejects it; `sync: true` delivers | CONFIRMED (schema); worker parse from reading `packages/jobs/src/execute.ts:215` | one recipient rule on both paths — the one `envelopeAddress` applies | `packages/mail/src/driver-parity.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 4 | `packages/render/src/duration.ts:27` | `parseTtlMs('0s')` returns `0`; the number arm returns `null` for `0` (`:21`) | `revalidate: { ttl: '0s' }` registers; `entryTtlMs` treats 0 as tag-only → after 10 simulated days still `hit`, `s-maxage=60`, `isr.entry_ttl_invalid` logged per request | CONFIRMED | `packages/render/src/duration.test.ts`, `modes.test.ts` |
| 5 | `packages/ai/src/llm.ts:412-418` | `respondToolFor` projects a non-object `output` straight into `input_schema`; nothing refuses it at declaration. `.stream()` documents `t.string` as supported (`:364-366`); `asToolInput` (`wire.ts:130`) coerces an array answer to `{}` | `llm({ output: t.string })` sends `input_schema: {"type":"string"}`; a prose answer costs two provider calls and ends `X_LLM_OUTPUT_INVALID` | CONFIRMED (stub provider) | `packages/ai/src/llm.test.ts` |
| 6 | `packages/ai/src/gateway.ts:381` | `cacheKeyFor` keys tools by name only; every `llm()` tool is named `respond` | two requests differing only in the `respond` `input_schema` share a key — an answer shaped for the old schema is served after a schema change | CONFIRMED (key equality) | `packages/ai/src/gateway.test.ts` |
| 7 | `packages/ai/src/rag.ts:39-51` | `flush()` carries overlap units, then pushes the next unit with no size check | units of 10, 500, 400 tokens, `size: 512, overlap: 64` → chunks `[511, 901]` | CONFIRMED | `packages/ai/src/rag.test.ts` |
| 8 | `packages/ai/src/rag.ts:34,122` | caller metadata spread over the framework's `source` key; `indexDocument` prunes by `{ source: document.id }` | index `doc1` with `metadata: { source: 'upload' }`, re-index shorter → `doc1#1..#3` stay searchable. Inverse (cross-document prune) follows from the code, not run | CONFIRMED | `packages/ai/src/rag.test.ts` |
| 9 | `packages/ai/src/eval-baseline.ts:39,55` | baseline written rounded to 3 decimals, compared with `now < was - tolerance` | score `2/3`, `tolerance: 0` → regresses against its own baseline | CONFIRMED | `packages/ai/src/eval-baseline.test.ts` |
| 10 | `packages/mail/src/mime.ts:84` | `Reply-To` and `List-Unsubscribe` emitted `verbatim` | `replyTo: 'José Muñoz <jose@x.test>'` → raw 8-bit header bytes; same for a non-ASCII `unsubscribeUrl`. Overlaps the 09-28 plan's "Reply-To not address-encoded" row — re-check before planning | CONFIRMED | `packages/mail/src/mime.test.ts` |
| 11 | `packages/manifest/src/sources.ts:122-131` | queries projected without `input`; `QueryDescriptor` has no such field. README promises it; `diffQueries` (`diff-operations.ts:94`) can never fire on a real manifest | — | CONFIRMED (reading) | `packages/manifest/src/sources.test.ts` |
| 12 | `packages/ui/src/theme/theme.ts:28-30` | `resolveTheme` is `stored ?? OS`; ignores the app default render's boot script applied | `themeScriptBody({ fallback: 'dark' })`, OS light, nothing stored → first `toggleTheme` click does nothing; `watchOsTheme`, `clearTheme` override the app default | CONFIRMED | `packages/ui/src/theme/theme.test.ts`, the cross-package pin in `cli` |
| 13 | `packages/ui/src/form/form-binding.ts:84` | `schema['~standard'].validate(values)` awaited outside the `try` | a throwing `validate` → `submit()` rejects with a raw `TypeError`; state stays `submitting` forever | CONFIRMED | `packages/ui/src/form/form-binding.test.ts` |
| 14 | `packages/ui/src/components/DataTable.tsx:95-107` | `decided = branch()` and two early returns run once at component setup | in an island, a table first failed or empty never leaves `ErrorState` / `EmptyState` | PLAUSIBLE (not run in a browser) | `packages/ui/src/components/DataTable.test.tsx` |
| 15 | `packages/pwa/src/service-worker.ts:128-131`, `route-rules.ts:90` | `personalPages: 'last-member'`: a personal route with `offline: 'precache'` gets `cache: 'precache'` and is absent from the precache manifest | `/dashboard` never kept for offline; the same route with `offline: 'runtime'` is | CONFIRMED (rule); consequence from reading `pages-cache-source.ts:35` | `packages/pwa/src/service-worker-pages.test.ts` |
| 16 | `packages/pwa/src/route-rules.ts:98-110` | patterns built from the decoded route path; `ruleFor` tests the percent-encoded `url.pathname` | `/precios-españa`, `/a b` → the worker never handles them | CONFIRMED | `packages/pwa/src/route-rules.test.ts` |
| 17 | `packages/mcp/src/readonly-sql.ts:155,343` | the banned-function scan reads quoted identifiers verbatim; does not decode `U&"…"` | a banned function spelled as a Unicode-escaped quoted identifier is accepted by `assertReadOnlyQuery`. The file says this ban is the only one holding on PGlite. Same root as [`sweep-1-security.md`](sweep-1-security.md) M4 | CONFIRMED (not executed against a database) | `packages/mcp/src/readonly-sql.test.ts` |
| 18 | `packages/ai/src/pg-vector-sql.ts:96,126` vs `vector.ts:103-116` | lexical half differs by driver: `websearch_to_tsquery` ANDs terms; memory BM25 scores any term | a multi-word question with lexical hits in tests can return none on Postgres | PLAUSIBLE, low confidence | `packages/ai/src/pg-vector.live.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/render/src/navigation-rules.ts:101` | `hashOnly` tests `to.hash !== ''` — `<a href="#">` soft-navigates and re-fetches | CONFIRMED |
| `packages/render/src/navigation-rules.ts:116` | `new URL(facts.href)` throws a bare `TypeError` for `href="http://"` | CONFIRMED |
| `packages/render/src/navigation-history.ts:52` | `decodeURIComponent(hash)` inside the swap; a malformed fragment falls into the reload catch | PLAUSIBLE |
| `packages/render/src/static-path.ts:13,48`, `render-static.ts:120` | `prerender()` returning `{ id: 7 }` or `null` escapes as a bare `TypeError` | CONFIRMED |
| `packages/render/src/route.ts:302,315`, `modes.ts:87,94` | `JSON.stringify` of the caller's value in a cause; `offline: 1n` throws `TypeError`. `renderCauseValue` is already used at `route.ts:323` | CONFIRMED |
| `packages/render/src/render-stream.ts:120` | default `errorFallback` interpolates the hole id unescaped; `holeMarker` (`:57`) escapes it | reading |
| `packages/render/src/render-isr.ts:149` | pattern fallback takes the first table match; `*` sorts before `:` — `/docs/*path` can supply the TTL for `/docs/:id` | PLAUSIBLE |
| `packages/pwa/src/manifest.ts:144` | `display_override` hard-coded `['standalone','minimal-ui']`, overriding `display: 'browser'` / `'fullscreen'` | CONFIRMED |
| `packages/pwa/src/push.ts:175` | `event.data.json()` on a non-JSON push throws before `waitUntil` | reading |
| `packages/ai/src/openai-wire.ts:109`, `wire.ts:71` | unknown `finish_reason` reads `end_turn` on one provider, `max_tokens` on the other | CONFIRMED |
| `packages/ai/src/scorers.ts:55` | `numericTolerance(0)` scores an exact match `0` | CONFIRMED |
| `packages/ai/src/remote-embedder.ts:150-174` | a second local `detailOf` with no `withoutKey` scrub | reading |
| `packages/ai/src/agent.ts:327-353` | tools requested on the final turn execute, then `X_AGENT_MAX_TURNS` | reading, low confidence |
| `packages/mail/src/driver-smtp.ts:70-71` | `smtp://user:pa%ss@host` throws a bare `URIError` | CONFIRMED |
| `packages/mail/src/mime.ts:135-141` | an ASCII phrase with a comma is not quoted: `To: Doe, Jane <jane@x.test>` | CONFIRMED |
| `packages/mail/src/mail.ts:93` | `registeredMails()` sorts with `localeCompare`; `registeredMailIds()` by code unit | reading |
| `packages/notify/src/channel-mail.ts:28-31` | a recipient with no address is counted `delivered: 1`, settled `sent`, zero mailer calls | CONFIRMED |
| `packages/manifest/src/build.ts:110`, `emit.ts:49` | a `NaN` fact hashes as `NaN`, writes as `null`; `verifyBuildId` fails the round trip | CONFIRMED (hand-built fact) |
| `packages/manifest/src/diff-entities.ts:93-107` | a NOT NULL column losing its default reports only `internal buildId` | CONFIRMED |
| `packages/manifest/src/diff-routes.ts:19-60` | a route gaining `surface`, `hydrate` or `budget` reports nothing | CONFIRMED |
| `packages/mcp/src/meta-surface.ts:224` | `destructive === false ? 'query' : 'action'`; `registry.ts:312` treats `undefined` as a read | reading |
| `packages/mcp/src/readonly-sql.ts:192` | word regex splits on digits — column `set2` refused as `set` | CONFIRMED |
| `packages/ui/src/toast/toast-state.ts:98` | two raw NUL bytes in a template literal; git treats the file as binary | CONFIRMED |
| `packages/ui/src/theme/inline-script.ts:5-8` | header says "removed in 21"; still exported at `index.ts:316-320` | CONFIRMED |

## Gaps

- `notify` ships only `createMemoryDigestStore` — `digested` events live in process memory; a restart loses them. Pg stores exist for ledger and inbox only.
- `manifest`: `QueryFact` carries no MCP exposure or rate limit; `diffRateLimit` covers actions only.
- `packages/mcp/src/list-params.ts:97-108` — `listParamsSchema` keeps every base input property; header says "nothing else admitted". Low confidence.
- `packages/pwa/src/strategies.ts:160,180,228` — exported strategies await `cache.put`, emitted ones do not; header calls them identical.
- `packages/pwa/src/route-rules.ts:105` — `/docs/*path` → `^/docs/.*/?$` misses `/docs`, which `static-path.ts` allows.
- `packages/ai/src/provider.ts:470-472` — `estimateTokens` reserves unclamped `maxTokens`; `estimateCost` clamps.
- No eval test uses `tolerance: 0`.

## Not a bug (do not re-open)

- `budget.ts` reserve / record / release, root turnstile; `Gateway.stream` reservation.
- Unscoped vector stores — memory and pg agree.
- Notify ledger re-claim; inbox ordering (`collate "C"`).
- MCP `validateArgs` (`Object.hasOwn`, `defineProperty`); `structuredResult`.
- `db.query` over-refusing columns named `comment` / `start` — stated design.
- Service worker `healSkew`; `speculationRulesTag` escaping.
- SMTP dot-stuffing, `foldHeaderLine`, reply-size guard, STARTTLS buffered-bytes refusal.

## Not read — handed to sweep 2

| Package | Files |
|---|---|
| `ui` | `qr-matrix`, `qr-encode`, `tokens/`, `theme/brand.ts`, `catalog/`, `icons/`, ~40 components, every `.scss` — token and raw-colour rules unaudited |
| `render` | `module-loader`, `css-modules`, `sass-cache`, `server`; DOM-side router not executed |
| `mcp` | `dev-ui-tools`, `dev-ui-interact`, `dev-host` |
| `manifest` | `diff-admin`, `sources-admin` |
| `mail` | `templates/`, `blocks`, `catalog`, token half of `layout` |
| `ai` | `hive-result`, `agent-facts`, `openai-models`, `fix-line*`, `fetch-seam`; pgvector SQL not run |
