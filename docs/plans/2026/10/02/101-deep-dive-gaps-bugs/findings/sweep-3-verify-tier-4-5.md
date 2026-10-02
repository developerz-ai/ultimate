# Sweep 3 — falsification and citation check, tiers 4–5 and architecture

> Findings for [`../overview.md`](../overview.md). Adversarial re-check at `2ea5eb17` (23.0.0), As of 2026-10.
> Subject: [`sweep-1-tier-4.md`](sweep-1-tier-4.md), [`sweep-2-ui-tier-4.md`](sweep-2-ui-tier-4.md),
> [`sweep-1-tier-5-scripts.md`](sweep-1-tier-5-scripts.md),
> [`sweep-2-admin-testing-scraping-scripts.md`](sweep-2-admin-testing-scraping-scripts.md),
> [`sweep-1-architecture.md`](sweep-1-architecture.md), [`sweep-2-architecture.md`](sweep-2-architecture.md).
> **No high or medium row was refuted. Three sub-claims refuted, six rows narrowed, one new defect.**
> **Where this file corrects a citation or narrows a row, this file wins.**

## 1. Corrected citations — the approximate rows of `sweep-1-tier-4.md`

| Row | Cited | Actual `file:line` and symbol |
|---|---|---|
| 1 hive | `hive.ts:72` | `packages/ai/src/hive.ts:134` — `currentBudget() ?? new BudgetLedger({ limits: {} })` |
| 2 fanout | `fanout-digest.ts:50,56` | `packages/notify/src/fanout.ts:130`, `:30-33` exact; digest steps `fanout-digest.ts:37`, `:70`, `:76` |
| 7 rag chunk | `rag.ts:39-51` | `packages/ai/src/rag.ts:51-76` (`flush`), `:78-83` (push loop; `:80` flushes, never re-checks size after the carry) |
| 8 rag metadata | `rag.ts:34,122` | `rag.ts:59` (`{ source: input.id, ...metadata }`), `:186` (prune by `{ source: document.id }`) |
| 9 eval baseline | `eval-baseline.ts:39,55` | `packages/ai/src/eval-baseline.ts:70,74` (written through `round`), `:94` (`now < was - tolerance`), `:110` |
| scorers | `scorers.ts:55` | `packages/ai/src/scorers.ts:93` in `numericTolerance` (`:85`) |
| channel-mail | `channel-mail.ts:28-31` | `packages/notify/src/channel-mail.ts:61-65` — and argued at `:46-49`, see §3 |
| 11 manifest queries | `diff-operations.ts:94` | `packages/manifest/src/sources.ts:122-131` exact; `diffQueries` `diff-operations.ts:105`, dead compare `:120-121`; `QueryDescriptor` `packages/query/src/query.ts:203`; `QueryFact.input?` `packages/manifest/src/schema.ts:176` |
| diff-entities | `diff-entities.ts:93-107` | `packages/manifest/src/diff-entities.ts:85-114`; `hasDefault` read only for added columns (`:121`) |
| diff-routes | `diff-routes.ts:19-60` | `packages/manifest/src/diff-routes.ts:28-63` |
| notify gap | — | `createMemoryDigestStore` — `packages/notify/src/digest.ts:81` |

## 2. Other wrong citations (about 60 spot-checked)

| File, row | Cited | Actual |
|---|---|---|
| sweep-1-tier-4 3 | `mail/src/job.ts:8,14,15,16` | `:14` (`to`), `:20` (`replyTo`), `:21` (`cc`), `:22` (`bcc`) |
| sweep-1-tier-4 12 | `ui/src/theme/theme.ts:28-30` | `:44-46` (`resolveTheme`) |
| sweep-1-tier-4 13 | `ui/src/form/form-binding.ts:84` | `:155` |
| sweep-1-tier-4 14 | `DataTable.tsx:95-107` | `:140-155` |
| sweep-1-tier-4 low | `pwa/src/manifest.ts:144` | `:160` |
| sweep-1-tier-4 low | `mail/src/driver-smtp.ts:70-71` | `:87-88` |
| sweep-1-tier-4 low | `mcp/src/meta-surface.ts:224` | `:302` |
| sweep-1-tier-4 low | `ai/src/remote-embedder.ts:150-174` | local `detailOf` `:228`; unscrubbed call `:135` |
| sweep-1-tier-4 18 | `pg-vector-sql.ts:96,126`, `vector.ts:103-116` | `pg-vector-sql.ts:136-138`, `:174-175`; `vector.ts:149-170` (`searchText`) |
| sweep-2-admin low | `scraping/src/expect.ts:333-336` | `:78-88` |
| sweep-2-admin low | `scraping/src/http-recorded.ts:59` | `:65-67` |
| sweep-2-admin 14 | `testing/src/template-db.ts:147-151` | lock `:132`, unlock `:146`, drop + clone `:148-149`, pooled client `:93` |
| sweep-1-architecture 5 | `scripts/lib/tiers.ts:88-92` | `:82-86` |
| sweep-1-architecture 2 | "16 occurrences in 15 files" | 17 in 16; unlisted: `cmd-deploy-helm.ts:70`, `island-bundle.ts:367`, `app-mcp.ts:69` |
| sweep-2-architecture H5 | "~1,495 lines of auth" | 1,333 with tests, 756 without |

Every other citation checked is exact.

## 3. Verdicts

| Finding | Verdict | Evidence |
|---|---|---|
| sweep-2-ui 1 — QR (critical) | REPRODUCED | a second, independent decoder over `encodeQr(text).modules` (8 px modules, 4-module quiet zone) returns nothing for four inputs across versions 1–3. Control: a reference encoder at the same version and level, same rasteriser, decodes all four |
| sweep-1-tier-4 14 — DataTable | REPRODUCED | a scratch island (real `buildIslands` + Solid, `mountIsland`): `error` set, cleared, `rows` set → `table` count stays 0, text stays the ErrorState. `AsyncRegion.tsx` does it reactively through `{content()}` |
| sweep-2-ui 6 — Textarea | REPRODUCED | `<Textarea value="abc">` in an island → `textContent` `"\nabc"` (micro-DOM) |
| sweep-2-ui 5 — `useId` | NARROWED | each default island chunk inlines its own counter (`packages/cli/src/island-bundle.ts:392`, one build per island). Unchecked: `islands.sharedChunks: true`. The "latent" premise is stale — `examples/dummy` islands import ui components (`settings.island.tsx`, `feed.island.tsx`) |
| sweep-2-ui 3 — RTL centring | STANDS | compiled with the repo's sass: logical `inset-inline-start: 50%` beside a physical `translate(-50%)` in all three; zero `[dir=rtl]` / `:dir()` rules. Not run in a browser |
| sweep-2-ui 2 — scroll restore | STANDS | no `pageshow` / `pagehide` handler, no restore at start; `scrollTo` only at `navigation.ts:300`, `:455` |
| sweep-2-ui lows — Tabs, Meter, Popover `aria-controls` | STANDS | read; compiled |
| sweep-1-tier-4 15 — `last-member` precache | REPRODUCED | the rule is `"c":"precache"` while `PRECACHE_MANIFEST` holds only `/offline`. The skip is deliberate (`service-worker.ts:126-127`); the rule's cache name is the defect (`route-rules.ts:90`) |
| sweep-1-tier-4 16 — encoded patterns | REPRODUCED | neither pattern matches `new URL(…).pathname` |
| sweep-1-tier-4 17 — Unicode-escaped identifiers | REPRODUCED | `assertReadOnlyQuery` refuses the plain and quoted spellings, accepts the escaped one. Not executed against a database |
| sweep-1-tier-4 18 — lexical parity | STANDS | no Postgres run |
| sweep-1-tier-4 11 — manifest query input | NARROWED | `QueryFact.input` is documented optional (schema-erased), but `sources.ts:122-131` never sets it for any query — `diff-operations.ts:120` is dead and `packages/manifest/README.md:22` is false |
| sweep-1-tier-4 low — `render-isr.ts:149` | REPRODUCED | `docs/[id]` + `docs/[...path]` → `describeRoutes()` returns `['/docs/*path', '/docs/:id']`; the first-match fallback picks the catch-all for `/docs/7` |
| sweep-1-tier-4 low — `meta-surface.ts` | NARROWED | only a hand-registered `McpTool` can omit `destructive` — `app-tool.ts:105` and `from-action.ts:137` always set it |
| sweep-1-tier-4 low — `diff-routes` "gaining" | **REFUTED** | argued at `packages/manifest/src/diff-routes.ts:37-39,82`: a side carrying nothing is "no evidence" |
| sweep-1-tier-4 low — `channel-mail` | **REFUTED** | argued at `packages/notify/src/channel-mail.ts:46-49`: a missing address is settled as sent and logged `notify.address_missing`, deliberately |
| sweep-1-tier-4 lows — `navigation-history.ts:52`, `render-stream.ts:119-120`, `push.ts:175`, `mail.ts:93`, `agent.ts:327-353`, remote-embedder | STANDS | read |
| sweep-1-tier-5 3 — datetime truncation | STANDS here; REPRODUCED in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) | — |
| sweep-2-admin 8 — audit tenant scope | STANDS here; REPRODUCED in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) | also `packages/admin/src/screen-resource.tsx:248` passes no `orgId` |
| sweep-2-admin 12, 14 and lows | STANDS | read at the corrected lines |
| sweep-1-architecture 1 — comparators | REPRODUCED | the table re-run gives the same four disagreements. The kind is spelled `'numeric'`, not `'decimal'` |
| sweep-1-architecture 5 — scraping tier | STANDS | floor is 4; an owner call (argued in the `FLOOR_ABOVE` row) |
| sweep-1-architecture 6 — stub drivers | NARROWED | both throw on every method, declared an "honest stub". **Sub-claim REFUTED**: `packages/jobs/src/driver.ts:270-284` has exactly six required methods plus optional ones — the header is right |
| sweep-1-architecture 7 — unused config keys | STANDS | readers: the validator (`config.ts:327,333`) and the layer merge (`:424-430`) only |
| sweep-2-architecture H1 — api routes | REPRODUCED | `registerRoute` with `apps/web/api/hook/route.ts` under every render mode → `X_ROUTE_MODE_INVALID`; `…/page.tsx` → `X_ROUTE_FILE_INVALID`. Nothing registers |
| sweep-2-architecture H2 — `x routes` | REPRODUCED | 57 routes: `app` 52, `site` 5, none `api`, none health |
| sweep-2-architecture M2 — `channel` | STANDS | no argued exception anywhere; one passing mention at `docs/architecture/21-client-data-layer.md:6` |
| sweep-2-architecture M5 — pwa exports | NARROWED | zero consumers anywhere: `subscribeSource`, `renderPushPayload`, `subscriptionState`, `registerBackgroundSyncSource`. The other three are used inside pwa — only their export is unused |
| sweep-2-architecture H5 — demo imports | REPRODUCED | the demo imports none of `auth`, `storage`, `notify`, `time`, `mail`, `seo`; `cache` and `pwa` are declared dependencies with no import |
| sweep-2-architecture M1 — generator layout | REPRODUCED | the dry run plans 34 files in the directory form; the reference app holds the flat form. Stated as allowed at `docs/architecture/12-generated-app.md:126` — an owner call |

## 4. New

| # | Where | Finding |
|---|---|---|
| 1 | `packages/ui/src/components/Popover.module.scss:50-58`, `:26-34`; `Popover.tsx:77-78` | inline placements are never positioned beside the anchor. Both a placement and an align class always apply (default `align-start`); the combined rule (specificity 0,2,0) resets `inset-inline-start` / `-end` to `auto` and overrides the placement rule (0,1,0). The panel falls to its static inline position, over the anchor. Fix: reset only the align-owned property. From compiled CSS; not run in a browser |
| 2 | `packages/testing/src/fixture-island.ts:182` | `modulePathFor` names the temp module by content hash in one per-process directory — two islands with byte-identical chunks import as one module instance and share module state. Low confidence on impact |
| 3 | `packages/ui/CLAUDE.md:34`, `packages/ui/src/a11y.ts:31-33` | "no client runtime exists" — four `examples/dummy` islands render ui components. The premise behind three "latent" notes is stale |

## Not re-checked

- Rows already CONFIRMED by a sweep probe, unless listed.
- sweep-2-ui lows for `css-modules`, `navigation.ts:277-278`, `navigation-swap`.
- sweep-2-architecture H3, H4, M3, M4, M6, M7, L1–L8, and the doc-drift tables beyond the lines above.
