# 03 — Bugs: tiers 4–5

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 4–5.

`render` · `pwa` · `mcp` · `ai` · `manifest` · `mail` · `ui` · `admin` · `testing` · `cli` ·
`create-ultimate`. Verified against `f2f41f5`. The `docker/` findings this sweep surfaced live in
[`11-deploy-ci.md`](11-deploy-ci.md).

## Critical

- `packages/render/src/head.ts:115` — **stored XSS on the 0kb `site/` surface.** JSON-LD `<script>`
  content is emitted raw (`:114 isRaw`), and `head-seo.ts:35` copies `@ultimat3/seo`'s `tag.text` — a
  bare `JSON.stringify(node)` (`packages/seo/src/meta.ts:250`) — into `content` unchanged. seo's
  *own* serializer escapes it (`meta.ts:263`: `.replaceAll('</','<\\/')`); render's does not, and
  render's is the path every real document takes (`packages/cli/src/dev-render.ts:67-71` — `x dev`,
  ISR, SSR, stream, prerender). Trigger: any row whose text lands in `ld`.
  `examples/dummy/apps/web/site/blog/[slug]/page.tsx:56,60` feeds `data.title` straight into `ld:` on
  an `isr` route. Proven: output contained a literal
  `</script><script>alert(document.cookie)</script>`. Fix: escape script/style content in
  `renderTag` — `raw.replaceAll('</','<\\/')` for `kind === 'script'` (valid inside JSON *and* JS);
  refuse or escape `</style`. Note `head.test.ts:162` ("script and style content are emitted raw, not
  escaped") **pins the vulnerable behaviour** and must change; its exact-equality case still passes
  under a `</`-only escape.

- `packages/mail/src/smtp-client.ts:208` — **SMTP command injection via `bcc`**, the one recipient
  field no header check ever sees. `buildMimeMessage` gates every header on CR/LF (`mime.ts:57`) but
  deliberately never emits `Bcc` (README: "`Bcc` never reaches a header — it travels in `RCPT TO`
  only"). `envelopeRecipients` (`driver.ts:61`) still hands `bcc` to `smtpDeliver`, which
  interpolates `RCPT TO:<${recipient}>`. Nothing between `send()` and the socket validates addresses
  on the inline path (`mail.ts:153`, `sync: true` or no job driver); `mailMessageSchema`'s `t.email`
  covers the queued path only. Proven: `to`/`cc`/`replyTo`/`subject` all rejected with
  `X_MAIL_HEADER_INVALID`; only `bcc` accepted, wire transcript showed
  `"RCPT TO:<evil@example.test>\r\nRCPT TO:<victim@bank.test>\r\n"`. An attacker-controlled bcc adds
  recipients, or injects `\r\nDATA\r\n…\r\n.\r\n` to send a forged message through the app's
  authenticated relay. Fix: validate every value in `envelopeRecipients()` and `envelope.from` for
  CR/LF/`<`/`>` before the command is built — reuse `headerInvalid`
  (`packages/mail/src/errors.ts:115`) or apply `mime.ts:57`'s guard in `driver.ts:61` so both
  transports inherit it.

- `packages/testing/src/harness.ts:64-70` — `describeApp`/`testApp` teardown **unseals the network and
  restores the real clock for every later test in the process.** `close()` calls `resetNetwork();
  unsealNetwork(); restoreDeterminism();` unconditionally, but `boot()`'s `sealNetwork()` is a no-op
  when the preload already sealed (`sealed-network.ts:57-58`) and `installDeterminism()` already ran
  in the preload — the harness restores state it never captured. Proven:
  `BEFORE sealed=true determinism=true now=2026-01-01T00:00:00.000Z` →
  `AFTER sealed=false determinism=false now=<real wall clock>`. `bun test` is one process, so every
  later *file* runs with real `globalThis.fetch` (**unmocked egress reaches the internet**), a real
  `Date` and a real `Math.random` — defeating four of the package's own stated rules
  (`packages/testing/CLAUDE.md`). The framework's suite survives only because `harness.test.ts:13-16`
  hand-patches it in an `afterAll` whose comment admits the leak verbatim; a scaffolded app
  (`scaffold-repo.ts:164`) gets no such patch. Second facet, same lines: `boot()` (`:42-45`) calls
  `installDeterminism()` with only `AppOptions.seedValue/now`, so a run configured with
  `ULTIMATE_TEST_NOW`/`ULTIMATE_TEST_SEED` (`preload.ts:14-20`) is silently reset from the first
  `describeApp` onward. Fix: capture-and-restore as `fixture-network.ts:36-57` already does.

- `packages/admin/src/list.tsx:44` and every `t('admin.…')` call site — **every user-facing string in
  the admin's production views renders as the loud-miss placeholder `⟦admin.…⟧`.** Proven:
  `registerFrameworkCatalog(); t('admin.list.loading')` → `⟦admin.list.loading⟧`, while `t('ui.close')`
  → `Close`. All 27 keys emitted by `list.tsx`, `detail.tsx`, `form.tsx`, `actions.tsx`, `layout.tsx`,
  `page-guard.tsx` and `widgets.tsx` are absent from `packages/i18n/src/catalogs/en.json` and from
  both tracked apps' catalogs (only `admin.denied.body` exists). Drift runs both ways: the catalog
  ships `admin.nav.*`, `admin.dashboard.*`, `admin.entities.*`, `admin.table.*` that no code reads.
  Fix: add the emitted keys (the `dev.panel.*` block in the same file is the pattern), delete the
  unread ones. `@ultimat3/i18n` already exports `extractKeys`, `catalogMissingKeys` and
  `auditCatalogs` — a gate step over those makes it a build error, per axiom 3.

## High

| # | Site | Defect |
|---|---|---|
| 1 | `packages/cli/src/templates/scaffold-container.ts:131-133` | the scaffolded `backfill` compose service runs the **web** role forever instead of the backfill, and `x deploy` blocks on it |
| 2 | `packages/ai/src/budget.ts:183-197` + `gateway.ts:49-52,80-84` | `Gateway.scope`'s documented shared ledger is false for every `llm()`/`agent()` call |
| 3 | `packages/render/src/registry.ts:110` | `routePathFromFile` uses `indexOf` instead of the match position, mis-deriving every URL under a directory whose name ends with a surface name |
| 4 | `packages/render/src/render-isr.ts:162-167` | every rendered ISR path registers a permanent cache-graph dependent, never unregistered on LRU eviction |
| 5 | `packages/render/src/hydrate.ts:71-76,96-103` | a second interaction before the island's chunk loads flushes the replay queue before mount, losing every queued event |
| 6 | `packages/pwa/src/background-sync.ts:114` | the no-Background-Sync fallback posts `flush-outbox`, which the generated `sw.js` never handles |
| 7 | `packages/ui/src/components/Textarea.tsx:34`, `Select.tsx:41` | `value` passed as an HTML attribute the platform ignores — SSR renders an empty textarea and an unselected select |
| 8 | `packages/admin/src/mcp-tools.ts:145` | an admin **action** tool is derived with `input: []`, so every argument is rejected before the handler runs |
| 9 | `packages/admin/src/pagination.ts:114-133` | a backward page computes `hasMore`/`nextCursor` as a forward page, stranding the operator on page one |
| 10 | `packages/cli/src/parse.ts:210` + `cmd-db.ts:181` | a bare `x db` runs `x db gen` (writes migration files), not the `migrate` the code intends |
| 11 | `packages/cli/src/prerender.ts:87-91` + `budgets.ts:54-63` | `X_BUDGET_UNMEASURED` is unclosable and its `fix:` names a command that cannot produce the measurement |

Detail on each:

1. The scaffolded image is `ENTRYPOINT ["bun", "apps/web/server.ts"]` (`scaffold-container.ts:67`)
   and `server.ts` reads **only `Bun.env`**, ignoring argv (`scaffold-app.ts:354-362`). The compose
   service passes `command: ['db','backfill','--all','--write','--json']` → argv discarded, `ROLE`
   still `web` from the Dockerfile `ENV` (`:45`), so the container serves HTTP and never exits.
   `x deploy` (`cmd-deploy.ts:34,74-77`) runs `docker compose run --rm backfill` last and awaits it,
   so a scaffolded app's deploy **hangs indefinitely** at step 6. For an app whose compose predates
   the service (`examples/dummy/docker/docker-compose.prod.yml` has none) the step fails with "no
   such service" → `X_DEPLOY_FAILED`; proven via `x deploy --dry-run --json`. Fix: dispatch a
   non-empty `Bun.argv.slice(2)` through the CLI, and make `ROLE` the only selector — the framework's
   own image chose the other convention (`/app/x` + argv) and the two must not disagree.

2. `llm()` (`llm.ts:259-261`) and `agent()` (`agent.ts:161`) `derive()` a child ledger and run under
   `withBudget(child)`. `derive()` shares the `store` (so actor/org token counters propagate) but
   starts `requestTokens` and `costMinor` at zero with no parent reference, so `record()`
   (`budget.ts:205-208`) debits only the child. Proven through a real `llm()` action inside
   `gateway.scope(...)`: `gateway.spent()` returned `{minor:0}` for a call costing `{minor:3}`; under
   `createGateway({ budget: { request: 6000 } })`, **ten** sequential ~4,000-token calls all
   succeeded — >20,000 tokens under a 6,000-token ceiling. `agent.ts:283-285`'s own comment depends
   on the property this breaks, so `budget.tokensPerRun` is also unenforced. Fix: give `derive()` a
   parent handle; have `record()`/`debit()` forward `costMinor` and `requestTokens` upward.

3. `surfaceOf` uses an anchored segment regex (`surfaces.ts:62`); `indexOf(\`${surface}/\`)` is a raw
   substring search. Proven: `packages/webapp/app/page.tsx` → `/app` (should be `/`);
   `myapp/app/dashboard/page.tsx` → `/app/dashboard`; `mysite/site/pricing/page.tsx` →
   `/site/pricing`. Reachable in production — `packages/cli/src/app-load.ts:129` passes the
   app-root-relative path and the app directory is user-chosen (`apps/*`). Every downstream fact
   (sitemap, `sw.js`, manifest, ISR keys) inherits it silently. Fix: return the match index from
   `surfaceOf` and slice from `match.index + match[0].length`.

4. `registerPath` adds to `registered` and calls `registerDependent`; the only removal is `attach()`'s
   detach closure (`:263-265`). `memoryIsrStore.set` (`:64-68`) evicts silently with no callback, and
   `packages/cache/src/graph.ts:44-59` keeps three process-global maps keyed by dependent id. Proven
   with a 10-entry store and 500 paths: `store paths: 10`, `cache-graph dependents: 500`,
   `revalidateByTags returns: 500`. Unbounded growth — the scenario `DEFAULT_ISR_MAX_ENTRIES` exists
   to prevent one layer down, and named in the doc comment at `:41-47`. Fix: give `IsrStore.set` an
   eviction seam (or reconcile `registered` against `store.paths()` in `regenerate`) and call
   `unregisterDependent({ kind: 'isr-route', id: evicted })`.

5. `boot` sets `el.__x = 1` then returns `import(e).then(...)`; a second call short-circuits on
   `!e||el.__x` and returns `Promise.resolve()`, whose `.then` flushes `q`, sets `done = true` and
   removes the listeners. After two fast clicks during load both dispatched against an unmounted
   element — the precise failure the replay mechanism's own comment (`:92-95`) says it prevents. No
   test covers it. Fix: memoize the boot promise on the element.

6. `registerBackgroundSyncSource()` emits an `online` listener posting `{type:'flush-outbox'}`; the
   SW's message handler (`service-worker.ts:274-281`) handles only `'skip-waiting'` and `'build-id'`.
   Proven: *sw handles flush-outbox* `false`, *client emits* `true`. On Safari/Firefox the queued
   offline mutations are never drained — silent data loss of exactly the case the fallback exists
   for. Fix: handle it in the emitted listener and list the marker in `capabilities.ts:64`.

7. `value` is not an HTML attribute on either element and `attributePair`
   (`packages/render/src/html.ts:84`) serializes it verbatim; there is no client runtime yet
   (`packages/ui/CLAUDE.md`), so this is the only path. **Data-loss path**:
   `packages/admin/src/widgets.tsx:119-128` renders every prose and `json-editor` column through
   `Textarea` in edit mode — an operator opening `/admin/<entity>/<id>/edit` sees an empty body
   field and submitting blanks the column they were never shown. `Select` breaks
   `LocaleSwitcher.tsx:56` (always the first locale) and `ThemeToggle.tsx:68` (always "System"). Fix:
   render the textarea's value as its child text; emit `selected` on the matching `<option>`. Correct
   pattern: `Checkbox.tsx:36`'s `checked`, which *is* a real attribute.

8. Proven: `adminToolCatalog(app)` → `{"name":"admin.action.publish","destructive":true,"input":[]}`;
   `validateArgs(schema, {id:'p1', confirmation:'post:p1'})` → both rejected as unknown properties.
   `ToolRegistry.resolve` (`packages/mcp/src/registry.ts:195`) validates before `tool.handle`, so the
   call never reaches `dispatch`. A **destructive** admin action is permanently uncallable over MCP
   (`mcp.ts:123-125` requires a `confirmation` the schema forbids sending); a non-destructive action
   always receives `{}`; `AdminAction.input` — documented at `registry.ts:159` as "handed to the form
   and to the MCP tool definition" — is read by nothing. Fix: mirror the correct `delete` branch at
   `mcp-tools.ts:93-103`.

9. Proven (pageSize 2, 3 rows): the backward query `{"before":{…},"limit":3}` returns 2 rows and
   `pageFrom` answers `hasMore false, nextCursor null`; `list.tsx:110-116` disables Next and
   `:103-106` leaves Previous enabled on the true first page, re-requesting it forever. Root cause:
   on a `before` page, overflow means "more rows exist *before* this page" and `slice(0, pageSize)`
   keeps the wrong end unless the repo reverses — which `AdminListQuery.before` (`registry.ts:123`)
   never specifies, so no repo can make it right. Fix: branch on the decoded cursor's `direction`;
   specify the ordering contract on `AdminListQuery.before`.

10. `readSubcommand` returns `allowed[0]` when no subcommand token is present, so
    `ctx.args.subcommand` is never `undefined` and `cmd-db.ts:181`'s `?? 'migrate'` is dead code.
    Proven: `["db"] → "gen"`, `["secrets"] → "show"`, `["mcp"] → "serve"`. `x db` therefore writes
    `.sql` + `.snapshot.json` + `.hash` into `packages/db/migrations`. Fix: return `undefined` when no
    token is present and let each command state its own default — which every `?? '<default>'` call
    site already assumes.

11. `writeBuildStats` is called only from `prerenderSite`, reached only by `x build --target static`;
    `x build` **defaults to `--target docker`** (`cmd-build.ts:22`) and writes no stats file. Worse,
    `prerenderSite` measures only routes where `isPrerenderable` (`config.render === 'static'`), so
    every `ssr`/`isr`/`stream`/`spa` route declaring a `budget:` can never be measured by any
    invocation. Both tracked apps declare budgets predominantly on `ssr`/`isr` routes
    (`examples/dummy/apps/web/app/posts/[id]/page.tsx:25`, `.../site/blog/page.tsx:25`,
    `dummy/social-media-clone/apps/web/site/feed/page.tsx:23`) and both pin `budgets` in
    `scripts/lib/gated-apps.ts` with the stated remedy "running `x build` ahead of this gate" —
    provably not a remedy. Permanently red with a fix line an agent cannot act on (axiom 4). Fix:
    measure a route in whatever mode it declares, or emit `X_BUDGET_UNMEASURABLE` for modes that
    cannot be weighed; make the fix name the target that produces stats.

## Medium

| Site | Defect |
|---|---|
| `packages/ai/src/models.ts:160-164` | `moreCapableThan` walks one flat cross-vendor ladder, so `X_LLM_REFUSED` on the top OpenAI model tells the operator to switch to a Claude model no configured provider serves — and it is a cross-family *downgrade*, the retry the function exists to prevent |
| `packages/cli/src/dev-render.ts:180` | ISR keyed on `url.pathname` alone while the document depends on the full URL; **and** `modes.ts:110` refuses `static` + `policy` but not `isr` + `policy`, so a gated ISR route caches one actor's HTML under a shared key |
| `packages/render/src/render-stream.ts:125-140` | a hole whose `resolve` never settles holds the response open forever — no deadline, no link to any request timeout; the rejection path at `:132-137` is correct and has no way to fire |
| `packages/render/src/registry.ts:351`, `router-client.ts:113` | `decodeURIComponent` on a dynamic segment throws `URIError` instead of reporting no-match; `prefetch` is driven by an attribute an attacker can plant in user-generated HTML |
| `packages/pwa/src/service-worker.ts:239` | the SW posts an `AppUpdateAvailable` missing four of the five fields `version-skew.ts:150-157` declares, so the entire forced-reload machinery is unreachable through its only producer |
| `packages/pwa/src/strategies.ts:96,117,162` | every strategy caches any `response.ok`, ignoring `no-store`/`private`, and `app/`-surface routes get a cache rule by default — user A's `/dashboard` HTML served to user B on the same profile |
| `packages/pwa/src/service-worker.ts:229-242` | nothing bounds the `runtime`/`pages` caches within a build id; past the origin quota the browser evicts the whole origin including the precache |
| `packages/pwa/src/capabilities.ts:66` | `shareTarget` publishes `share_target` to the OS but emits no handler and no route rule, and a POST target needs a `fetch` handler `fetchBlock` returns early from |
| `packages/testing/src/fixture-clock.ts:18-28` | the `clock` fixture has no disposer, so `clock.advance()` leaks the frozen instant into every later test and file (proven) |
| `packages/testing/src/template-db.ts:131-140` | a migration failing after `CREATE DATABASE` poisons the template permanently — run 2 swallows "already exists", skips `migrate` by design, and every later test runs schema-less |
| `packages/testing/src/matchers.ts:137-146` | `toMatchOpenApi` compares only `operationId` removals, so a newly-required input field — `manifest/src/diff.ts:83-85` calls it breaking — passes clean |
| `packages/testing/src/fixtures.ts:104-114` | `requestedFixtures` stops at the first `}`, so `({ clock: { now }, mail })` yields `["clock"]` and `mail` dies as "cannot read property of undefined, naming nothing useful" — verbatim what `fixtures.ts:1-6` says the module exists to eliminate |
| `packages/manifest/src/schema.ts:162-172` | `isManifest` validates 5 of 12 fields and the 7 it skips are dereferenced unguarded by `diffManifest` — a trimmed manifest passes the trust gate then throws an uncoded `TypeError` in place of `X_MANIFEST_DRIFT` |
| `packages/manifest/src/docs-scan.ts:195` | one unparseable `package.json` throws out of the entire docs scan, killing `x docs` with an uncoded error and contradicting the module's own skip-a-non-package policy |
| `packages/manifest/src/emit.ts:60` | `Bun.stdout.write(text)` not awaited → `--json` truncation; the same defect already fixed once in `packages/cli/src/write-line.ts` |
| `packages/cli/src/output.ts:186-194` | `--json` drops `lines`, so `x build --json` on a failed build carries no build log — the exact failure the step-output carve-out at the same site exists to prevent, one field over |
| `packages/admin/src/widgets.tsx:102` | a foreign-key cell links to `/${entity}s/${value}`: no `basePath`, naive `+ "s"`, resource `path` ignored — a 404 on every reference cell |
| `packages/admin/src/crud.ts:104-107` | `adminList` appends no audit entry on either path, against `audit.ts:2-3`, `permissions.ts:31` ("Never false") and `packages/admin/README.md` |
| `packages/ui/src/a11y.ts:21-30` | `useId` is a process-global counter never reset per render, so identical input yields different markup — prerender/ISR output is not reproducible and server ids can never match a client hydrate |
| `packages/ui/src/theme/inert-render.test.ts:222-228` | 26 cases pass or fail on module-load order; `bun test packages/ui` is 260/0 but `bun test packages/ui packages/admin` is 26 red. The documented `bun run test` exits 1 |
| `packages/admin/src/dev/panel-db.ts:52-62` | `assertReadOnly` gates on statement keywords only, so `select pg_advisory_lock(1)`, `select pg_sleep(30)`, `select my_writer()` all pass; `packages/mcp/src/readonly-sql.ts:91-109` already refuses these by called-function prefix |
| `packages/mail/README.md:90`, `packages/admin/README.md:84` | documented APIs that do not exist (`x mail list`/`preview`; `<Widget input={…} />` vs the real `{field, value, ctx, mode}`) |

## Low

Grouped; each is one line of work.

- **mcp**: `resources.ts:129` silently overwrites a duplicate URI where `registry.ts:143-149` throws;
  `server.ts:98-102` answers `resources/*` and `prompts/list` with no caller filter while
  `tools/list` is per-caller; `readonly-sql.ts:91-104` omits the SQL-executing XML family
  (defence-in-depth only — layers 1–2 still refuse).
- **render**: `hydrate.ts:41,44`, `head.ts:145-147`, `render-spa.ts:42,45,49-51` interpolate into
  attributes/inline scripts unescaped (author-controlled today); `router-client.ts:97-98` grows
  `scrollPositions`/`prefetched` unbounded for the SPA session.
- **mail**: `smtp-socket.ts:43,74-76` `ChunkQueue` holds one `waiting` slot and a second concurrent
  `read()` orphans the first (exported public API, no documented single-reader constraint);
  `idempotency.ts:14` omits the `mailId` on the explicit-key branch, so two different mails sharing a
  caller key collide.
- **manifest**: `emit.ts:61,67,70` reports `text.length` (UTF-16 units) as bytes — 314 vs 326 actual
  on a manifest with a Japanese locale; `agents-md.ts:53` gets it right with `Buffer.byteLength`.
  `diff.ts:53` vs `:209-217` classify a permission removal two ways, so a pure loosening demands a
  major. `sources.ts:79-85,86-95` publish no query `input` and always-empty job `steps`, so two diff
  rules can never fire.
- **pwa**: three error classes and `PWA_OWNED_ERROR_CODES` are not re-exported though
  `staleWhileRevalidate` throws the first; `service-worker.ts:219` double-`?`s a precache URL with a
  query; `:266` downgrades a navigation's `mode`/`redirect` per the Fetch spec (CONFIDENCE: low, from
  spec not measurement). **Weighting note: `packages/pwa` is effectively unwired** —
  `generateServiceWorker`, `generateWebManifest`, `retentionPlan`, `updateSignal`, `subscribeSource`
  and `registerBackgroundSyncSource` have no caller anywhere; only `planIcons`/`BuiltinImagePipeline`
  are used (`packages/cli/src/dev-assets.ts:13,171`). No build step emits `sw.js` or
  `manifest.webmanifest`, so every pwa finding is latent until the CLI wires it.
- **testing**: `template-db.ts:131,139` issue session-scoped advisory locks through a `Bun.SQL` pool
  (CONFIDENCE: low — sequential awaits almost certainly reuse one connection).
- **cli**: `serve.ts:236-281` leaks the OTLP exporters, the queue and embedded Postgres when
  `buildIslands`/`startRoles` throws (no `try/finally`); `guards.ts:165-167` reads `code`/`cause`/`fix`
  twice against `output.ts:83-84`'s own read-once rule; `workspace-checks.ts:163`'s `TEST_EXCLUSION`
  misses `*.test.tsx` though `test-select.ts:25` added `.tsx` for exactly this reason (zero such files
  today); `cmd-generate.ts:279-311` claims "the whole set is proven before any of it lands" but
  interleaves conflict detection with writes; `cmd-build.ts:136` renders a success summary on
  `result.ok === false` and `:114-116` emits `{"command":"verify"}` for `x build --json`.
- **admin**: `search.ts:94` reaches `repo.list({ limit })` with no ceiling while `pagination.ts:83`
  clamps at 200; `crud.ts:182-186` `adminUpdate` writes any declared column including `readOnly`,
  `sensitive` and the primary key when called with a raw body (MCP path is safe);
  `dev/server.ts:177` reports an unknown panel key as `X_ADMIN_ENTITY_UNKNOWN`, so `x errors explain`
  gives the wrong subject.
- **ui**: `a11y.ts:64-97` `createFocusTrap` and `announce` are exported and called by no component,
  and `:77`'s `!root.contains(active)` branch is unreachable.

## Tests

- Failing-first per Critical/High. Key ones: `ld` containing `</script>` renders escaped
  (`head.test.ts:162` must be rewritten — it currently pins the bug); a `bcc` with CRLF is refused
  before `RCPT TO`; a second `describeApp` file still sees a sealed network and a frozen clock; every
  `t('admin.*')` key resolves (a catalog-completeness gate over `catalogMissingKeys`);
  `routePathFromFile('apps/webapp/app/page.tsx')` → `/`; 500 ISR paths over a 10-entry store leave 10
  dependents; two fast interactions during island load both replay after mount;
  `renderToHtml(Textarea({value:'x'}))` contains the text; an admin action tool's schema accepts its
  declared input; a backward page reports `hasMore`; `parseArgs(['db']).subcommand === undefined`.
- `bun test packages/ui packages/admin` must be green — the module-order failure is real and the
  documented `bun run test` exits 1 today.

## Done when

- Every Critical and High fixed with a failing-first test; the two tests that currently pin buggy
  behaviour (`head.test.ts:162`, and `harness.test.ts:13-16`'s hand-patch) are rewritten rather than
  worked around.
- Admin catalog keys are complete and enforced by a gate step.
- `bun run test` (not just the sharded gate) exits 0.
- `bun run verify` green.
