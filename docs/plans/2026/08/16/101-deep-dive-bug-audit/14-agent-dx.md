# 14 — Agent DX: the first hour with the framework

> Part of [`overview.md`](overview.md). Depends on: none, but 4/5/11 overlap — fix each once. Tier:
> `cli` (5) + templates + docs.

The framework's thesis is that **the primary developer is an AI agent** and every decision the
framework makes is one the agent does not have to. This slice is where it fails its own thesis.

Method: three apps scaffolded in a scratchpad and actually used — `npmapp` (pure published path,
`bunx create-ultimate@latest`), `blogly` (local CLI + npm packages), `localapp` (local CLI + `file:`
overrides to today's `main`). Every generator, every introspection command, six deliberate mistakes.
Findings ordered by agent-time cost. A full session log is at the end of the source report; the
reproductions below are quoted from it.

## Critical

### 1. The published path is red on the first command

```
bunx create-ultimate@latest npmapp && bun install && x verify
  → ✗ 1 of 17 steps failed — X_TYPECHECK_FAILED on the scaffold's own entity.ts
    ('c.title' is possibly 'undefined' ×2)
x entities   → X_ROUTE_DUPLICATE: / is claimed by both
               apps/web/site/page.tsx and apps/admin/app/page.tsx
```

"One command means shippable" is false for the first command an agent runs. CI cannot see it:
`.github/workflows/ci.yml`'s `scaffold-smoke` is `continue-on-error: true` **and** rewrites every
`@ultimat3/*` range to a `file:` override, so it tests neither the published packages nor the gate's
outcome. Nothing anywhere asserts that a fresh app passes. Fix: drop `continue-on-error` once 2–5
land, and add a post-release job that installs from the registry rather than from `file:`. (Same
waiver as [`11-deploy-ci.md`](11-deploy-ci.md) and [`10-tests.md`](10-tests.md) — one fix.)

### 2. `x db migrate` is a dead end on the release and an infinite loop on `main`

**Published (1.2.0)**, following the scaffold README's own first line `bin/setup`:

```
X_DB_MIGRATE_FAILED  cause: bunx drizzle-kit migrate exited 1: drizzle.config.json does not exist
                     fix:   x db reset
x db reset        → X_DB_MIGRATE_FAILED (identical)   fix: x doctor --json
```

The escape hatch fails identically. `wiki/Known-Gaps.md` presents the drizzle shell-out as a 1.1.0
defect "Fixed on `main`, unreleased" — but **1.2.0 is what npm serves and it still shells out**, so
the wiki reads as fixed for the version a reader is on.

**On `main`** — worse, because the fix is executable and still does not fix:

```
x db migrate               → X_DB_DRIFT: migration "0000_initial" records no schema snapshot
                             fix: x db gen "snapshot initial"
x db gen "snapshot initial" → "entities and migrations agree — nothing to generate"  (writes nothing)
x db migrate               → X_DB_DRIFT (identical)          ← loops forever
```

Cause: `packages/cli/src/templates/scaffold-db-package.ts:110` writes `0000_initial.sql` and `.hash`
but **no `.snapshot.json`**; `x db gen` refuses to create one because the diff is empty. The scaffold
ships a migration the migrator permanently rejects. Fix: emit `0000_initial.snapshot.json` from the
template; and make `x db gen` treat "a committed migration has no snapshot" as something to generate,
not as agreement.

### 3. `packages/cli/src/mcp-errors.ts:125` — `x errors explain` returns the same `fix:` for 327 of 378 codes

`fix: cli ? CLI_FIXES[code] : 'x verify --json'`. Ten lookups run live —
`X_TENANCY_UNSCOPED`, `X_FORBIDDEN`, `X_POLICY_MISSING`, `X_N_PLUS_ONE_QUERY`,
`X_MATCHER_UNSUPPORTED`, `X_QUERY_NOT_PAGEABLE`, `X_CACHE_TAG_UNKNOWN`, `X_MIGRATION_DESTRUCTIVE` —
every one answered `fix: x verify --json`. The command's own summary is *"an X_* code, explained:
cause, **runnable fix**, docs URL"*. 51 CLI-owned codes get a real fix from `CLI_FIXES`; the other 327
— every code an app author actually hits — get the constant. **The same function backs the MCP
`errors.explain` tool**, so the AI-first surface hands back a constant too.

There are **618 hand-written `fix:` strings** in `packages/*/src/*.ts` — the framework's single best
asset — and the lookup command reaches none of them. Fix: `collectDeclaredCodes`
(`packages/cli/src/error-contract.ts`) already walks every declaration site; capture the literal
`fix:` alongside the code and serve it. Where a fix is interpolated with no literal, say so rather
than substituting a constant. CONFIDENCE on the exact count: low (378 manifest codes minus the 51 in
`packages/cli/src/error-codes.ts`); the mechanism is certain.

### 4. `packages/cli/src/cmd-verify.ts:168,222` — the gate discards app-load findings, so modules that do not load pass `x verify`

```
x manifest → ✗ manifest not written — 2 module(s) did not load
x verify   → ✓ manifest 9ms
```

Two authorities, opposite answers, same tree. `budgets` is the one step that loads the app
(`const { manifest } = await appManifest(ctx.root);`, `:168`) and it **destructures `findings`
away**. `driftFindings` (`:222`) returns `[]` before loading whenever no `x.manifest.json` is
committed — always true of a scaffolded app, because nothing tells an agent to run `x manifest` and
running it fails. Fix: `budgets` already has the findings in hand — spread them into its result. That
closes it with **no eighteenth step**, which is the constraint the file's own comments care about.

### 5. `packages/cli/src/templates/action.ts:99` — every generator emits an `errors.ts` that fails the gate's own `errors` step

Both `x new` and `x g resource` produce:

```
X_ERROR_FIX_INVALID (apps/web/app/post/errors.ts:11)
  cause: cites "x db studio", which is planned and exits X_NOT_IMPLEMENTED
```

The framework's flagship "errors are instructions" worked example is itself an invalid error, and
`x g resource` writes a **new gate failure on every invocation**. Fresh regression from the commit
that moved `x db studio` into `PLANNED_SUBCOMMANDS`: the rail was added, the one template it convicts
was not updated.

Compounding: this **blocks the fix for finding 6.** `x build` runs the `errors` step, so
`x build && x verify` cannot succeed until the agent hand-edits a file the generator wrote — a circle
confirmed in session: `budgets` → `x build` → `errors` → the scaffold's own template. Fix: change the
template's fix to a shipped command (`x dev  # then the db panel at /_x`, which is what `x db studio`'s
own `X_NOT_IMPLEMENTED` says), and add the emitted templates to whatever `error-contract` already
scans so a template can never again ship a fix the gate rejects.

### 6. `packages/cli/src/budgets.ts:57` — no scaffolded app can ever be green on `budgets`

Following the fix verbatim: `x build` refuses (default target `docker` runs its own 6-step gate
first); `x build --target static` succeeded and wrote `.x/build-stats.json` containing **exactly one
entry, `/`**. `/admin` (spa), `/dashboard` (ssr) and `/pricing` (isr, generated by `x g route
--surface site`) stayed `X_BUDGET_UNMEASURED` with the same `fix: 'x build && x verify'` that had just
run successfully.

Only the prerender path writes stats and it walks static routes only — but `x new` and `x g route`
stamp a `budget:` on **every** route (`packages/cli/src/templates/route.ts:75`,
`templates/scaffold-app.ts:43,120,312`). A declaration the measurement path structurally cannot reach
is a permanent red. Smallest fix: stop generating `budget:` on non-static render modes, and make
`X_BUDGET_UNMEASURED` say *why* a route is unmeasurable when its mode is not prerendered — the current
cause implies the build simply has not run. Same defect as
[`03-tier45-bugs.md`](03-tier45-bugs.md) High #11 and [`08-architecture.md`](08-architecture.md) H4;
fix once, across all three.

### 7. Two documented non-negotiables are not enforced anywhere

| Non-negotiable (`CLAUDE.md`) | Enforcement found |
|---|---|
| "No raw colours. Semantic tokens only, in every component and stylesheet" | **none** — `X_TOKEN_UNKNOWN` checks a token *role name* at the API level, never a hex literal in SCSS |
| "No hardcoded user-facing strings. Everything through `t()`" | `x i18n check` exists and works, but is **not a `x verify` step**, and audits only catalog key coverage — it reported `✓ no gaps` with a literal `<h1>All comments here</h1>` in place |
| No `any` | enforced (biome `noExplicitAny`) — caught |

Adding `.raw { color: #ff0000; background: rgb(0,0,255); }` to a generated `page.module.scss` and
replacing a `t()` call with a literal both **passed `x verify`**. By axiom 3, two documented
non-negotiables do not exist. Fix: add a literal-string scan to `x i18n check` (it already walks
source via `source-files.ts`) and ride `i18n` on the `lint` or `boundaries` step; add a hex/rgb rule
for `*.scss` to the same walk. Both are host-check-shaped and need no new step. Corroborates
[`04-projection-contract.md`](04-projection-contract.md)'s enforcement-gap table — same five
conventions, reached from the opposite direction.

## High

| # | Site | Defect |
|---|---|---|
| 8 | `packages/cli/src/templates/policy.ts:77` | every generated feature carries a **factually false** comment: "the role map is app-global and `defineRoles()` replaces it wholesale". `packages/policy/src/roles.ts:79-95` **merges**, and its own docblock says "It used to replace…". The template preserved the pre-fix rationale, and `examples/dummy/apps/web/shared/policies.ts:16` repeats it. An agent that believes it avoids roles permanently and hand-rolls `permissions: [...]` everywhere |
| 9 | — | **no shipped answer to "where do roles live".** `x policy` on a fresh scaffold shows four permissions and `roles: -`; nothing calls `defineRoles`, `app.config.ts` has no roles key, `@ultimat3/auth` is not even a dependency. Both tracked apps independently invented a location *and* a merge spelling, and they disagree (`examples/dummy/apps/web/shared/policies.ts:19` vs `dummy/social-media-clone/apps/web/app/auth/roles.ts:36` **and** `apps/admin/app/admin/policy.ts:93`, hand-rolled twice). Two apps solving one problem two ways is the definition of a missing framework decision. Fix: `x new` scaffolds `apps/web/shared/roles.ts`; `x g resource` merges into it the way it merges the i18n catalog |
| 10 | `x new` + `x dev` | the scaffold ships **11 guarded routes and no authenticator**. The boot warning is one of the best fix lines in the codebase (concrete call, concrete location, worked example) — and it is a `logger.warn` visible only if you run `x dev` and read stdout; `x verify` is green. `packages/cli/CLAUDE.md` records the reasoning ("a warning and not a throw, because `x new` scaffolds guarded routes before it scaffolds an authenticator") — which is the framework choosing to ship a broken default rather than fix the generator |
| 11 | `X_GENERATE_CONFLICT` | the generator is **non-atomic and its `fix:` destroys work**: `x g action publish-post --feature post` on an existing feature wrote 2 files, then aborted on `errors.ts already exists`, leaving a half-generated tree — and `x g --force` overwrites a hand-edited `errors.ts` with the template (including finding 5's bad fix line). Neither alternative is right. Fix: plan-then-write (the `--dry-run` plan already exists); skip an existing file and say so; reserve the code for a conflict on the primitive's own file |
| 12 | `X_ROUTE_FILE_INVALID` | the fix is runnable, succeeds, and **silently changes the URL**. Renaming `app/comments/page.tsx` → `comments.tsx` yields `mkdir -p 'app/comments/comments' && git mv … 'comments/page.tsx'`; running it turns `/comments` into `/comments/comments` and the check goes green, so the agent never learns. The overwhelmingly likely intent is `git mv comments.tsx page.tsx`. Fix: emit the in-place rename when the directory holds no `page.tsx`; offer the nested form only when one is present |
| 13 | `packages/query/src/errors.ts:127` | `X_ACTION_POLICY_MISSING`/`X_QUERY_POLICY_MISSING` interpolate the **primitive's** name into `can('${name}')`, rendering `policy: can('createComment')` where `can()` takes a `resource:verb` permission (`comment:write`). Pasted verbatim it typechecks only while no `PermissionRegistry` augmentation exists — and `isKnownPermission` returns `true` when nothing is declared — so in an early-stage app it silently installs a permission no role can ever grant. Credit: the missing policy *is* also a type error, which is the right primary rail |
| 14 | every introspection command | `x entities`, `x actions`, `x queries`, `x policy`, `x tasks`, `x routes`, `x actions describe` all printed correct tables, all **exited 1**, and all appended the same 12 lines of unrelated `X_ROUTE_MODE_INVALID`. `x actions describe` is the exact command four `X_ACTION_*` fix lines tell you to run. Fix: app-load diagnostics to stderr or behind `--verbose`; reserve exit 1 for "I could not answer" |
| 15 | the circular-fix family | of 618 `fix:` lines the great majority are genuinely good, only ~11 are "think about it", and **no shipped fix cites a planned command** (the `errors` step enforces that — which is how it caught the scaffold's own template). The real weakness is circularity: `X_TYPECHECK_FAILED` → `bunx tsc -b` and `X_TEST_FAILED` → the same `bun test` are defensible (the diagnostic *is* the output). The three that **run clean and change nothing** are not: `X_BUDGET_UNMEASURED` → `x build && x verify` (#6), `X_DB_DRIFT` → `x db gen` (#2), and `X_BUILD_FAILED`/`X_CLI_UNEXPECTED` → `x doctor --json` (diagnostic, and doctor does not check the port that actually failed) |
| 16 | `x fix boundary` | does not fix. Given `X_BOUNDARY_SITE_TO_APP` with `fix: x fix boundary <file>`, running it exits 1 and restates the violation — with a *better* fix line (`delete the import of … in …`). The command is diagnostic-only; its name and the fix line both promise repair. Fix: apply the cut, or rename it and move the good second-line text into the original error |

## Medium

- `x dev --port N` moves one port of three: web bound 3999, metrics 9090, then a third server crashed
  the process with `X_CLI_UNEXPECTED: Failed to start server. Is port 4000 in use?` — landing in the
  generic catch-all rather than `X_PORT_IN_USE`, whose message and fix already exist. `x doctor`'s own
  `fix: x dev --port 3001` therefore does not resolve a port conflict.
- `packages/cli/src/templates/scaffold-repo.ts:41,145` — `"@biomejs/biome": "^2.4.15"` against a
  pinned `"$schema": ".../2.4.15/..."`. `bun install` resolved 2.5.8 and `lint` reported a schema
  mismatch on **every** run of a fresh scaffold. A guaranteed-drifting pair, already drifted.
- `apps/web/prerender.ts:12` — the scaffold ships `Bun.env['SITE_ORIGIN']`, which trips
  `lint/complexity/useLiteralKeys` under the `biome.json` the same generator writes. With the previous
  item, `lint` is red on every fresh scaffold before the agent touches anything.
- `x docs` cannot reach the wiki. `wiki/` is "the only public documentation surface" and ships in **no
  package** (checked `node_modules/@ultimat3/**`); `x docs` indexes package source headers and READMEs
  only. `x docs "how do I grant a permission to a role"` returned four file headers, one of them
  `@ultimat3/db`'s Postgres `readonly-role`. As a *symbol locator* it is genuinely good
  (`x docs 'pagination'`, `x docs 'money'` both landed immediately) — but its summary claims questions
  are "answered offline", and an offline agent cannot read the tutorials or `Known-Gaps.md` at all.
  Fix: ship `wiki/` inside `@ultimat3/cli` and index it, or retitle the command.
- `x help` advertises `db … studio` with no `(planned)` marker though `x db studio` exits
  `X_NOT_IMPLEMENTED` (the top-level table marks all 10 planned commands correctly; the subcommand
  summary does not). `x migrate` → `X_CLI_UNKNOWN_COMMAND` with `fix: x upgrade`, itself planned —
  `cmd-planned.test.ts` enforces "no planned command's fix points at another planned command", but the
  nearest-match suggester is outside that rule; the obvious intent is `x db migrate`. `x generate` →
  `cause: "x g" is not a command`, denying that `g` — a real command — exists.
- `examples/dummy` demonstrates a pattern the framework replaced: the framework ships `Actor` +
  `ActorFacts` + `actorFact()` + `userActor()` as the authz-extension seam and
  `dummy/social-media-clone/apps/web/shared/actor.ts` uses it correctly, while
  `examples/dummy/apps/web/shared/actor.ts` declares a parallel `AppActor` interface and a hand-rolled
  `SessionService`. The app whose stated job is "every primitive, once, idiomatically" teaches the
  non-idiomatic answer for the single most-copied file in an app.
- `packages/cli/src/messages.ts:110` — `x new`'s next-step line is `cd {name} && x dev`, at a moment
  when `x` is not installed and no manifest exists. `x manifest` is mentioned nowhere, yet
  `x.manifest.json` is in the README's layout table.
- `x new --help` contradicts itself in one screen: the usage line reads `[--no-example]`, the flag
  table reads `--example  include the example feature slice`, and `cmd-new.ts:96` is
  `flags.get('example') !== false` — on by default.

## Low

- A permission typo produces `not assignable to parameter of type 'Declared'` — `Declared` is an
  internal alias (`packages/policy/src/permissions.ts:22`), so TS prints the alias instead of
  enumerating the valid permissions. The agent gets "wrong" without "here are the four right ones".
- `x g resource` emits an action named `create<Resource>` whose handler is `repo.byId(input.id)` and
  which throws `<Resource>NotFoundError` — an agent extends a body that contradicts its name.
- `x g resource` writes `admin.<name>.title` into the catalog without `--admin`, so `x i18n check`
  reports unused keys on a fresh scaffold. (The merge itself is correct — deep union, correctly
  nested.)
- `x db gen` renders its success condition with a ✗ (`✗ entities and migrations agree — nothing to
  generate`); same for `x build`'s `✗ built docker`. The ✗ is the appended route diagnostics of #14.
- `x doctor` reports only findings — no positive inventory of what was checked or which versions
  resolved, though its summary promises "environment, versions, drift, ports, PWA prerequisites".

## A version-skew finding, from comparing the three scaffolds

Local CLI + **npm** packages fails typecheck because `metaContextFor`/`routeDataFor` are missing from
`@ultimat3/render@1.2.0`, and because `entity`'s `invariants` **changed from array to function form
between 1.2.0 and `main`** — a breaking change to a documented API with no major bump. Semver applies
to this repo by its own statement (`CLAUDE.md:16`). Decide before the next release: major, or restore
the array form additively.

## Verified sound — do not "fix"

Missing `policy:` is a **type** error first (`Property 'policy' is missing in type 'ActionDef'`) —
two rails, compiler first. `definePermissions()` ordering is not a silent-typo footgun:
`KnownPermission` narrows the moment any module augments `PermissionRegistry`, every generated
`policy.ts` augments, and a typo is a compile error — the runtime laxity is the deliberate
pre-augmentation escape. `--json` is on **everything** — no command found missing it, and
`x verify --json` returns a clean per-step structure with `skipped` flags matching the human render.
`X_ROUTE_FILE_INVALID`, `X_BOUNDARY_SITE_TO_APP`, `X_ROLE_REDEFINED`, `X_CONFIG_INVALID`,
`X_ISLAND_INVALID` and `x db studio`'s `X_NOT_IMPLEMENTED` all carry genuinely executable,
correctly-scoped fixes — **the error contract works; the failures are concentrated in the lookup path
(#3) and in three fixes that run clean without fixing**. i18n catalog merging across `x new` +
`x g resource` + `x g route` is deep-union correct. The tier/boundary machinery is axiom 3 working: a
`site/ → app/` import was caught in 26ms with both endpoints named, and `x g guard` produced a working
app-authored build error. `bun install` — 78 packages in 542ms; the "first 60 seconds" claim fails on
correctness, never on speed.

## Done when

- `bunx create-ultimate@latest x && bun install && x verify` is green, asserted by a post-release CI
  job that installs from the registry.
- `x db migrate` succeeds on a fresh scaffold, on both the release and `main`.
- `x errors explain <any code>` returns the `fix:` its throw site wrote.
- A module that does not load fails `x verify`.
- No generator emits a file that fails the gate.
- A raw colour and a hardcoded string are each build errors.
- `bun run verify` green.
