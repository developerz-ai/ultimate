# DocsSite

Human-authored, short, stable — one file under two names, `AGENTS.md` being a symlink to it.
Facts live in `x.manifest.json`; this file holds only what an agent cannot infer from the code.

Every row below names what refuses it. A rule with nothing in the last column is a rule that does
not exist — five of these had an empty column and were each measured green on `bunx x verify`.

There is no global `x`: every command here is `bunx x …`, the CLI this app installs.

This app is Ultimate's docs site: `../../wiki/*.md` in, static pages out. Its own rules:

| Rule | Detail | Refused by |
|---|---|---|
| `wiki/` is the source | never copy wiki text into this app; edit `../../wiki/<Page>.md` and rebuild | nothing here holds a second copy: every page is read from `wiki/` at build time |
| Every link resolves | a wiki link to no page or heading stops the build, naming `wiki/<file>:<line>` | `X_DOCS_LINK_DEAD` (`packages/docs-source/src/errors.ts`) |
| Every code has a page | a code in `framework.manifest.json` with no `wiki/Error-Codes.md` row stops the build | `X_DOCS_CODE_PAGE_MISSING` |
| A page says what it is | a piece with no prose line has no description; a second `#` heading would be a second `h1` | `X_DOCS_LEAD_EMPTY`, `X_DOCS_SECOND_TITLE` |
| One markdown path | bodies render through `@ultimat3/ui`'s `Markdown` in `apps/web/shared/doc-body.tsx`; a piece past its cap stops the build | `X_DOCS_PIECE_OVERSIZE` |
| 0 KB but `/search` | every docs route declares `budget: { js: '0kb' }`; `/search` holds the one island | the `budgets` step |

Before stating or working around a framework limit, ask the installed framework:
`bunx x docs "<question>"`, and `bunx x errors explain <CODE>` for an error code.

Before an edit, ask what it reaches: `bunx x impact <file> --json` names the routes, actions,
queries, jobs, MCP tools, published operations and tests it touches, each with provenance.

| Rule | Detail | Refused by |
|---|---|---|
| One gate | `bun run verify` — `bunx x verify`, which builds what its `budgets` step weighs. Green means shippable; never merge red. CI runs the same two commands as your terminal: `bun run setup && bun run verify` | the gate itself, and `.github/workflows/ci.yml` on every push and pull request; `.github/workflows/image.yml` publishes only a commit it passed |
| Coverage | the unit suite covers 95% of the lines and functions of this app's own source — every file under `apps/` and `packages/`, one no test loads counted at 0%. A floor, not the goal: a test added to raise it is proven by mutation — break the source, watch it go red, restore | `X_COVERAGE_BELOW_FLOOR` on the `unit` step; `coverage` in `x.verify.json` states the floor, and it only rises |
| One way | generators, not hand-rolled files: `bunx x g resource`, `bunx x g action`, `bunx x g route` | review |
| Surfaces | `site/` is 0kb JS and may not import `app/`; `shared/` is a leaf | `X_BOUNDARY_SITE_TO_APP` |
| Data | routes call actions and queries; only `repo.ts` touches the database | `X_BOUNDARY_ROUTE_TO_DB` |
| Repos | a `repo.ts` reads through the typed handle, never a `sql` literal the handle can express | `guards/repo-raw-sql.ts` |
| Vendors | a server `fetch(` carries a `signal` in its own options — better, it is `outbound()` from `@ultimat3/core/outbound`: a deadline, the caller's signal, safe-only retry | `guards/raw-fetch.ts` |
| Polling | an island re-reads a query on a timer with `useQuery(ref, input, { poll: pollEvery(ms) })` (`@ultimat3/realtime`), anything else with `visibleInterval(run, ms)` from `@ultimat3/core/page` — no call while the tab is hidden, none after a lost session — never a bare `setInterval(`; a `// why:` on the line admits a tick that is not a read | `guards/raw-interval.ts` |
| Errors | never `throw new Error` — declare each code once, `defineError({ code, title, status, cause, fix })` from `@ultimat3/core`, and throw its class; never a handwritten `UltimateError` subclass | `guards/bare-error.ts`, `guards/error-declared.ts` |
| Money | `{ minor, currency }`, never a float — `money()` on the column | the type: `price: 19.99` is TS2322, `number` is not `MoneyInput` |
| Time | store UTC, format with an explicit IANA time zone | `guards/unzoned-date.ts` |
| Strings | every user-facing string goes through `t()` | `guards/untranslated-string.ts` |
| Colour | semantic tokens only, never a raw hex | `guards/raw-colour.ts` |
| Lengths | a length is a token or `rem()`, never a raw `px` | `guards/raw-length.ts` |
| Breakpoints | a viewport query names a breakpoint rung (`respond-up`, `respond-down`, `respond-between`), never a width | `guards/raw-breakpoint.ts` |
| Layers | a `z-index` is a named layer, never a number | `guards/raw-z-index.ts` |
| Shadows | a shadow comes off the shadow scale, never a hand-written offset and blur | `guards/raw-shadow.ts` |
| Timing | a duration and an easing curve come off the motion scale, never a literal | `guards/raw-motion.ts` |
| Classes | a class a component reads off its stylesheet is one that sheet compiles | `guards/undefined-style-class.ts` |
| Properties | a custom property a stylesheet reads is one the app declares | `guards/undeclared-custom-property.ts` |
| Interaction | a click is answered by a control — never a `<div onClick>`, and never a `role=` where the native tag exists | `guards/semantic-interactive.ts` |
| Focus | `outline: none` replaces the ring in the same rule or the one beside it, or it does not remove it | `guards/focus-visible.ts` |
| Images | every image carries width + height or an aspect-ratio, and the priority one is never `loading="lazy"` | `guards/image-dimensions.ts` |
| Motion | animate `transform` and `opacity` — never a layout property, never `transition: all` | `guards/animated-layout-property.ts` |
| Islands | every `*.island.tsx` has a sibling `*.island.states.ts`, so `bunx x shot --island` can photograph its failures | `guards/island-without-states.ts` |
| Size | one file, one job — 500 lines of reviewable logic, and split past it | `X_FILE_TOO_LONG` |

`guards/` is yours: each file is one rule, discovered by `bunx x verify` and run inside its
`boundaries` step. Delete one to drop the rule, and `bunx x g guard <name>` writes the next.

The last five rows are about what this app is like to USE, and each is decidable from the file
alone — which is why they are those five and not the many that are not. A role is a promise:
`role="button"` obliges you to answer Space, Enter, focus and disabled, and the native element
already does. Only `transform` and `opacity` animate without a layout pass. An image with no box
moves everything under it when its bytes land.

Size is a hard line and not a style note: past 500 lines a file has stopped being the
unit of review, and `bunx x verify` refuses it. The one exemption is a file that is nothing but re-exports —
it has one job by construction, and its length tracks the API's size rather than its complexity;
one statement of logic in such a file re-arms the ceiling on the same save.

Coverage counts execution, not validation: 100% is reachable with zero assertions, and a covered
branch whose test cannot fail is worse than an uncovered one, because it reads as done. An
`exclude` entry under `coverage` is for code a unit test cannot execute — an island's
browser-only mount, a container entry point — carries its `why`, and is printed by `bunx x doctor`.

Every test the scaffold and the generators write is the idiom to copy. All of them run on the
`unit` step — in process, on the in-memory driver, with no database, browser or server.

A suite that needs a real server reads it from `docker/test-services.env`: Postgres 18, Redis, NATS
and S3 from `docker/docker-compose.test.yml`, in RAM, with durability and logging off — CI starts
it before `bun run verify`, a laptop with `docker compose -f docker/docker-compose.test.yml up -d
--wait` then `set -a; . docker/test-services.env; set +a`. A resource a test opens is held with
`await using` — `await using db = await acquireWorkerDatabase()` drops its database however
the test ends:

| What | How its test runs it | Copy from |
|---|---|---|
| a page | `renderRoute(page, { url, actor })` — `load`, `meta` and the page on one resolution; assert on `view.text`, `view.html`, `view.meta`, `view.islands` | `apps/web/app/dashboard/page.test.ts` |
| a component | `renderView(Component, props)` | `apps/web/shared/shell.test.ts` |
| an island | `mountIsland`, once per state its `*.island.states.ts` declares | `apps/web/shared/theme-toggle.island.test.ts` |
| an action or a query | `target.as(actor, input)` — the refusal first, then what it answers | `apps/web/api/health.test.ts` |
| a job, a task, a backfill | `test('…', async ({ runJobs }) => …)` — a worker in this process; assert on `trace.steps` and each run's `outcome` | what `bunx x g job` writes |
| a repo, a seed | as an actor, `runWithContext(ctxOf({ actor }), …)`, with `driver.reset?.()` after each | `packages/db/src/seed.test.ts` |

Money is the one row with no guard, deliberately: a float has no static signature a text rule can
see, and the type already fires — measured, `price: 19.99` in a seed is
`TS2322: Type 'number' is not assignable to type 'MoneyInput'`. A guard that pretended to check
it would be worse than the type that really does.

`bun run verify` is `bunx x verify`, the whole gate: its `budgets` step runs
`bunx x build --target static` itself when `.x/build-stats.json` is missing or older than the
source, so nothing has to be built first.

Commands: `bun run setup`, `bun run dev`, `bun run verify`, `bunx x g <primitive>`,
`bunx x g guard <name>`, `bunx x db branch create <name>`, `bunx x doctor`. `setup` is
`bin/setup.ts`, a file Bun runs, so all three are the same command in PowerShell, cmd and bash.

- `bunx x g --help` lists every generator kind, and is the only place that list is stated.
- Destructive database work goes in a branch, `bunx x db branch create <name>`, never the shared
  dev database.
- `bunx x db gen` also writes `packages/db/schema/`, the whole schema as SQL, one file per
  table: read it, never edit it. `bunx x verify` fails with `X_SCHEMA_DUMP_DRIFT` when it is not
  what the migrations produce, and `bunx x db gen` rewrites it.
- `bunx x doctor` explains a broken environment and prints the fix for every finding.
- `.claude/` holds a harness that reads this file: `/feature`, `/planx`, `/verify` and four
  boundary-scoped subagents. `.claude/README.md` says what each costs; every file is deletable.

## Agent tools

| Tool | What it answers | How to reach it |
|---|---|---|
| `x.manifest.json` | every route, action, query, job and policy, generated — read it before searching the tree | `bunx x manifest` rewrites it |
| `bunx x impact <file|primitive> --json` · `bunx x graph --json` | what an edit reaches, and the app as one graph (declared, import and observed edges) | rebuilt from the loaded app on every call |
| `.mcp.json` | the dev tools over MCP: routes, schema, policies, the database, tests, the gate — `bunx x mcp tools` lists them | a client that reads `.mcp.json` starts it; from any other, run `bunx @ultimat3/cli mcp serve --transport stdio` here |
| `POST /mcp` | this app's own tools — every action declaring `mcp: { expose: true }` — for a remote agent | `apps/web/mcp.ts`; under `bun run dev`, `Authorization: Bearer dev-agent.admin`, else an API key |
| `.claude/commands/feature.md` | build or fix one thing end to end, done when `bun run verify` is green | plain markdown: any agent can read one and follow it |
| `.claude/commands/planx.md` | write a plan to `docs/plans/` for another agent to execute | the same |
| `.claude/commands/verify.md` | run the gate and fix what it reports | the same |

Project notes for docs-site: replace this line with the conventions a newcomer could not guess.
