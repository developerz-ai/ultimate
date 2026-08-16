# Deep-dive bug audit — twelve sweeps, one plan

## Goal

Fix what a twelve-agent audit found across the whole tree: correctness bugs, security holes,
concurrency defects, architectural incoherence, doc drift and DX failures. Full implementation is the
mandate — no slice resolves a finding by shrinking the documented surface.

## Context

- Bun-only monorepo, 28 `@ultimat3/*` packages plus `create-ultimate`, tiers 0–5
  (`scripts/lib/tiers.ts:9-16`), imports only go down. `As of 2026-08`, version 1.2.0.
- **No finding is a new primitive.** Every fix is a correction, a deletion, or a mechanism added to an
  existing primitive. Where the audit found a ninth primitive smuggled in
  (`mcp/src/app-tool.ts:30`, `mail/src/mail.ts:65`), the fix is to fold it back into `action`/`job`.
- Three findings were reached **independently by three separate agents** and two more by two agents —
  the strongest signal available on a read-only sweep. They lead their slices.
- The audit ran against `f2f41f5`, after the 2026-08-12 audit's findings had all merged. Everything
  that audit named was re-verified as fixed and is **not** re-reported; each slice carries a
  "verified sound — do not fix" section so the next agent does not re-audit settled ground.

## What the sweeps were

| Sweep | Lens | Slice |
|---|---|---|
| 1 | tiers 0–1 · tiers 2–3 · tiers 4–5 · scripts/CI/apps/docs | 01, 02, 03, 05, 11, 12, 13 |
| 2 | security · concurrency & lifecycle · projection & type soundness · test quality (mutation-tested) | 07, 06, 04, 10 |
| 3 | architecture · dead code & drift · logic & edge cases · agent DX (built three real apps) | 08, 15, 09, 14 |

## The nine findings that matter most

Ranked by blast radius, not by slice order.

| # | Finding | Where |
|---|---|---|
| 1 | **Unauthenticated cross-tenant file read.** `GET /media/*key` is `auth: 'public'` with no policy and no tenant check, mounted in production, answering `cache-control: public, immutable` for a year — plus an unauthenticated write path | [`07`](07-security.md) |
| 2 | **The tenancy guard is structurally inert on the job surface.** An explicit `ctx` is honoured as a parameter but never installed as the ambient context, and `@ultimat3/entity` derives tenancy from the ambient one. Proven: the same write is refused over HTTP and accepted through `.job()` | [`07`](07-security.md) |
| 3 | **Any query with `cache:` serves one tenant's rows to the next** — the read-cache key omits actor and tenant, and the tier is process-wide | [`02`](02-tier23-bugs.md) |
| 4 | **The framework's own Docker image cannot build**, falsifying `CLAUDE.md:29`; and the image that does build reads `ROLE` nowhere, so every compose service runs `x dev --once` | [`11`](11-deploy-ci.md) |
| 5 | **`bun run test` is red at HEAD** (26 failures, reproducible) while `x verify` is green — shard packing decides whether the failure is visible | [`10`](10-tests.md) |
| 6 | **`scripts/` typechecks nowhere.** An injected type error passes `tsc -b`; 7 real errors are sitting there now, one of which is a live bug | [`05`](05-gate-and-scripts.md) |
| 7 | **`nullable` is dropped from every projection** — OpenAPI, MCP, generated clients — and is already wrong in both apps' committed `openapi.json` | [`04`](04-projection-contract.md) |
| 8 | **The published `bunx create-ultimate` path is red on step one**, and `x db migrate` is an infinite fix-loop on `main` | [`14`](14-agent-dx.md) |
| 9 | **`app.config.ts`, "the one config file", configures nothing** — one of ~40 fields has a reader, and five `fix:` lines instruct an operator to edit fields that are inert | [`08`](08-architecture.md) |

## Claims in the tree that the audit falsified

Each needs its prose corrected in the same PR as its fix — a wrong claim in `CLAUDE.md` costs more
than the bug, because it is what the next agent reads first.

| Claim | Reality |
|---|---|
| `CLAUDE.md:29` — "the image build now ends in `/out/app --version`" | the build dies at `docker/Dockerfile:15` and never reaches it |
| `CLAUDE.md:16` — 29 packages "on npm in lockstep" | `release.yml:75-79` omits `@ultimat3/flags`, so a release publishes 28 — and the tag series (`v1.10.1`) disagrees with every `package.json` (`1.2.0`), so a release today dies `EPUBLISHCONFLICT` |
| `CLAUDE.md` / `README.md` — "49,981 received a channel patch" | a **reachability** measurement, not a consistency one: the bench client records `lastSeenSeq` and nothing reads it, and dropped channel frames have no counter, no log and no repair path |
| `wiki/Known-Gaps.md:9` — the `--define` gap is open | fixed; the row is stale (the image is broken for an unrelated reason) |
| `docs/architecture/01-package-map.md:99-155` | ~13 of its dependency edges do not exist, and its own "lowest tier their imports allow" rule is false for three packages |
| `docs/architecture/02-boundaries.md:95-99` | documents two boundary escape hatches with zero implementation |
| five documented non-negotiables | no raw colours, `t()`-only strings, IANA `timeZone`, float money, no `export *` — **none is a build error** |

## Tiers touched

| Package / area | Tier | Slice |
|---|---|---|
| `core`, `schema` | 0 | 01, 04, 08, 09 |
| `money`, `time`, `cache`, `seo`, `db`, `storage`, `i18n`, `flags` | 1 | 01, 06, 08, 09 |
| `entity`, `policy`, `http`, `auth` | 2 | 02, 07, 08, 09 |
| `action`, `query`, `jobs`, `realtime` | 3 | 02, 04, 06, 07, 08, 09 |
| `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail` | 4 | 03, 08 |
| `ui`, `admin`, `testing`, `cli` | 5 | 03, 10, 14 |
| `scripts/`, `docker/`, `.github/` | — | 05, 11 |
| `examples/dummy`, `dummy/social-media-clone` | app | 12 |
| `docs/`, `wiki/` | docs | 13 |

Land lowest tier first within a slice. An import that would go up or sideways is a design error, not
a `boundaries` exception.

## Plan files

Execute **05 first** — two of the gate's own checks provably do not check what they claim, so until
it lands, "`bun run verify` green" is not evidence for any other slice.

| Order | File | Covers |
|---|---|---|
| 1 | [`05-gate-and-scripts.md`](05-gate-and-scripts.md) | the gate lies: `scripts/` typechecks nowhere, no app suite floor, type-only imports dodge `boundaries` |
| 2 | [`10-tests.md`](10-tests.md) | `bun run test` red while the gate is green; the Redis Lua scripts have never executed; `timing-safe-equal`'s only property untested |
| 3 | [`07-security.md`](07-security.md) | cross-tenant `/media` read, job-surface tenancy bypass, dev overlay in production, MFA's missing second leg, four realtime capacity gaps |
| 4 | [`01-tier01-bugs.md`](01-tier01-bugs.md) | tiers 0–1: money conversion, a logger that throws, unbounded `Intl` caches, asymmetric cache-graph busts |
| 5 | [`09-logic-edge-cases.md`](09-logic-edge-cases.md) | wrong values that never crash: `MoneyValue.scale` dropped on persist, `Date` cursors that lose page 2, lexicographic `bigint` ordering |
| 6 | [`04-projection-contract.md`](04-projection-contract.md) | `nullable` dropped from every surface; `.job()` with no consumer; the query client typechecking against inputs its own route rejects |
| 7 | [`02-tier23-bugs.md`](02-tier23-bugs.md) | tiers 2–3: the tenant-blind read cache, unscoped idempotency keys, two realtime check-then-act races, 11 caller-caused codes answering 500 |
| 8 | [`06-concurrency-lifecycle.md`](06-concurrency-lifecycle.md) | a worker that stops claiming forever, drains with no deadline, a second server born draining, and what the 50k bench actually measured |
| 9 | [`03-tier45-bugs.md`](03-tier45-bugs.md) | tiers 4–5: JSON-LD XSS, SMTP `bcc` injection, a test harness that unseals the network for every later file, an admin UI rendering `⟦admin.…⟧` |
| 10 | [`11-deploy-ci.md`](11-deploy-ci.md) | the image that cannot build, the image that ignores `ROLE`, a release that publishes 28 of 29, secrets baked into scaffolded images |
| 11 | [`14-agent-dx.md`](14-agent-dx.md) | the published path red on command one, `x db migrate`'s infinite loop, `x errors explain` returning a constant for 327 codes |
| 12 | [`08-architecture.md`](08-architecture.md) | eight structural Criticals; mostly **deletions** — land after the bug slices so a fix and a deletion do not collide |
| 13 | [`12-tracked-apps.md`](12-tracked-apps.md) | both apps' call-site bugs; the demo runs on an in-memory driver on a public URL |
| 14 | [`15-dead-code-drift.md`](15-dead-code-drift.md) | built-but-never-called, duplication, and things that must agree and don't |
| 15 | [`13-docs-drift.md`](13-docs-drift.md) | documented commands that do not exist; three new checks so this class cannot recur. Land last, describing the fixed tree |

## PR shape

One slice, one PR — packages release independently, so slices do too. Tier order is the split order.
Several findings appear in more than one slice because more than one sweep reached them; each is
cross-linked, and the rule is **fix once, cite both**. The ones to watch:

| Finding | Slices |
|---|---|
| `X_BUDGET_UNMEASURED` unclosable | 03, 08, 14 |
| `scaffold-smoke`'s `continue-on-error` | 10, 11, 14 |
| no `x.verify.json` in either app | 05, 10 |
| `template-db` poisoning | 03, 10 |
| the read cache outside the fan-out | 06 (runtime), 08 (structural cause) |
| the 32-bit `fnv1a` | 02 (collision), 08 (five copies) |
| five unenforced non-negotiables | 04, 14 |

## Done when

- Every Critical and High fixed with a **failing-first** test; each Low fixed or carrying a
  `wiki/Known-Gaps.md` row.
- The three tests that currently **pin buggy behaviour** are rewritten, not worked around:
  `packages/render/src/head.test.ts:162`, `packages/testing/src/harness.test.ts:13-16`'s hand-patch,
  and the two Redis fakes that assert themselves.
- Every falsified claim above corrected in the PR that fixes it.
- Two decisions made explicitly and written into the owning package's `CLAUDE.md`, because both are
  design calls the current code sidesteps: **job-surface tenancy** (a boot-supplied service actor, or
  jobs declaring their tenant) and **`MoneyValue.scale`** (persist it, or refuse it at the boundary).
- `bun run test` and `x verify` agree, and both are green.
- `bunx create-ultimate@latest x && bun install && x verify` green, asserted by CI.
- New codes registered + documented + `bun run manifest`; `bun run scripts/reference-app-gate.ts`
  green with fewer pins; `bun run verify` green — all 17 steps, now meaning what they say.

## Risks / open questions

- **The ask assumed bugs exist; it was not falsified.** ~350 findings, ~35 Critical after dedup. What
  *was* falsified is narrower and worth stating: the authz **projection** model held under end-to-end
  tracing across HTTP, OpenAPI, typed client, job handle and MCP tool — the one break is a
  context-installation bug, not a policy-projection bug. Test **breadth** is genuinely strong: 17 of 19
  semantic mutations were caught. The eight primitives are closed and correctly implemented, and
  `llm()`/`backfill()` are real factories that inherit every projection.
- **`MoneyValue.scale` is a breaking decision either way** — persisting it needs a migration, refusing
  it narrows a documented type. Decide before touching `packages/entity/src/columns.ts`.
- **The job-tenancy fix fails closed.** `packages/cli/src/dev-roles.ts:286` builds the worker context
  with no actor, so installing the ambient context turns every tenant-scoped read into
  `X_TENANCY_ACTOR_ORG_REQUIRED`. It cannot land alone.
- **`entity`'s `invariants` changed from array to function form between 1.2.0 and `main`** — a
  breaking change to a documented API with no major bump. Semver applies by the repo's own statement.
  Decide before the next release.
- **`packages/pwa` is entirely unwired** (3,407 LOC, only `planIcons` reachable) and `offline:` is
  required on every route. Wire it or delete the field — do not leave it half-shipped a second time.
- **Deletions in 08 will conflict** with patches to the same files in 01–03. That is why 08 lands
  after the bug slices, and why anything it deletes should not be patched first — check 08 before
  fixing a Low.
- **Driver parity is the largest single class of defect** and slice 15 carries it: 15 top findings
  plus 27 more where two implementations of one interface answer one call differently. Every one
  passes the suite, because the suite runs the memory side. The fix that matters is not the 42
  patches — it is extending the `*-parity.test.ts` pattern the repo already has for jobs to cache
  tiers, storage drivers, auth adapters, ai providers, vector stores and mail transports.
- Two sub-audits inside slice 15 did not finish: the systematic `wiki/CLI-Reference.md`-vs-real-CLI
  diff and the header-comment survey over a 150-file sample. The eight lying headers listed there are
  a floor from incidental discovery, not a survey — re-run both if you want that ground closed.
