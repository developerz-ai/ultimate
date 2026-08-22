# CLAUDE.md

social-media-clone — a real social network on Ultimate, and the framework's stress test.
A router, not an encyclopedia. Facts live in `x.manifest.json`; this file holds what you cannot
infer from the code.

`x verify` here is **blocking on the framework repo's CI**, through the ratchet in
`../../scripts/lib/gated-apps.ts`: this app's own `expectedRed` pins `boundaries` and `budgets` —
2 red of 19 as of 2026-08-22 — and every other step must stay green. `boundaries` is
`X_BOUNDARY_SITE_TO_APP` ×3, `apps/web/site/feed/page.tsx` reaching `apps/web/app/posts/service.ts`;
`budgets` is `X_BUDGET_UNMEASURED` on every route declaring one, because no `.x/build-stats.json`
has ever existed here — closed by running `x build` ahead of the gate. `drift` is **not** pinned and
must stay green; that table is the executable copy, so read it rather than this line if they
disagree. `examples/dummy` has its own
table; neither app's pins excuse the other's red step. Turn a pinned step green and you must
delete its pin in the same change
(`bun run ../../scripts/reference-app-gate.ts --unpin dummy/social-media-clone:<step>`). This app is not the reference app — `examples/dummy` decides idiom — but it is deployed
(`.github/workflows/deploy-social-demo.yml`), which is why it is gated.

## Response rules

Lead with the action. No preamble. Parallel tool calls when the calls are independent. Read before
speculating. Disagree when I am wrong, with the `file:line` that proves it. Terse.

## Be proactive — own the outcome, not the ticket

- Fix the bug you can see in the file you are already editing.
- **Ship the guard with the fix**, in the same change. A rule that is not a build error does not
  exist. Climb as high up the ladder as you can afford: type → assertion at the seam → contract
  test → `scripts/lint/<rule>.ts` → a preventive rule here.
- The second time a ritual is awkward, it becomes a command or a script. Do not perform it twice.
- Leave the campsite typechecked: if your change makes a neighbouring file wrong, fix it or name it.
- "Done" means deployed and verified with a live probe — never "the code is written".

**Proactive owns the outcome; surgical cuts the scope.** Both, at once. Widening a diff because you
were there is not proactivity, it is a merge conflict for someone else.

## Know how to say no

Recovering the problem is worth more than building the solution. **"This shouldn't be built" is a
successful outcome**, not a failure to comply.

Say so — in one sentence, with the reason — when:

- the request needs a ninth primitive, a second authz path, or a second way to do something that
  already has one;
- the thing asked for is a symptom and the cause is one layer down;
- a smaller change gets 90% of the value, in which case propose that instead;
- you are being asked to silence a failing test, a type error or a lint guard. **The guard is the
  asset.** Never patch a symptom while the cause survives.

Then offer the nearest thing you *can* do, and get on with it. Do not moralize, do not hedge, do
not write three paragraphs about the tradeoff. If I hear the objection and repeat the request, that
is my decision — build it in full, state the assumption you are proceeding under, and move on.

Never ship a fix you know is wrong. If a stopgap is genuinely the right call, leave a pinning test
or a line in `docs/gotchas.md` — **never a bare `TODO`**.

## The loop

| Tier | Command | When |
|---|---|---|
| fast | `bunx x test unit --filter <text>` | after each edit |
| scoped | `bunx x test <type>` | before you believe a slice works |
| **the gate** | `bin/check` (= `x verify`, 19 steps) | once, before push, in the background |

**Do NOT reflexively run `bin/check`.** It is the pre-push gate, not the edit loop.

## Commands

`x dev` · `x verify` · `x g resource|action|mutator|query|job|route|policy|entity|task` ·
`x db gen "<msg>"` / `x db migrate` / `x db branch ls|create <name>|drop <name>` · `x jobs ls|show|retry|drain` ·
`x routes` / `x actions` / `x queries` / `x entities` / `x policy` / `x tasks` ·
`x errors explain <X_CODE>` · `x doctor` · `bun run scripts/help.ts`

Every command takes `--json`. **Never write a throwaway script** — check `scripts/help.ts` first;
if the verb is missing, add `scripts/<resource>/<verb>.ts` rather than improvising.

## Your access

| Need | Use |
|---|---|
| structure — who calls what | CodeGraph MCP. Not grep. Grep is for literal text |
| production data | the `db-gateway` MCP — read-only, audited. **Never** a hand-written `DATABASE_URL` |
| what is broken in prod | the `error-monitor` MCP. Errors are a work queue, not a dashboard |
| drive this app | the `app` MCP — same policy objects as HTTP, so it cannot reach a second authz path |

## Hard boundaries

- **Eight primitives, closed**: `entity` `policy` `action` `mutator` `query` `job` `route` `task`.
  A feature that fits none of them does not ship. A new capability is a **factory over an existing
  primitive**, never a ninth kind of thing.
- `site/` is 0kb JS, anonymous, and **may not import `app/`**. `shared/` is a leaf.
- Only `repo.ts` touches the database. A route importing `db` is a build error.
- Never `throw new Error` — subclass `UltimateError` with a stable `X_*` code, a cause, and a
  **runnable** `fix:`. "Check your configuration" is not a fix.
- No `any`. No default exports. No raw colours. No hardcoded user-facing strings.
- Money is `{ minor, currency }`. Never a float, never a bare number.
- No date formatted without an explicit IANA `timeZone`. There is no ambient default.

## Preventive rules — these bite before any symptom

| Rule | Mechanism, and what it costs when broken | Guard |
|---|---|---|
| A live `query` must be **ordered, bounded, and totally ordered** — the last sort key unique | the matcher decides a row's position from the `orderBy` alone; a partial order lets two rows swap between evaluations, so a bounded page silently drops or repeats one at the boundary | `x verify` live step |
| A `job` needs an `idempotencyKey` derived from **`input` alone** | a key that reads the clock makes every retry a new job; a key derived from nothing makes every night collide with the first run | the type requires it |
| A `mutator`'s `local` must be **convergent, not incremental** | `local` is replayed on every rebase. `count + 1` re-applies per replay and shows three likes for one person. Derive from a boolean the replay also sets | `mutator.test.ts` asserts `apply×3 === apply×1` |
| A `task` only **enqueues** | work inside a task runs on the scheduler, which is single-instance and unretried | review |
| `row === null` in a policy is a **denial**, never a pass | an absent fact is not a satisfied one; treating it as one hands anyone who holds the grant a way to skip the row check by reaching a surface that passes no row | `policy.test.ts` |
| Visibility here is **relational**, not a tenant column | this app has no `orgId`. Who may see a post depends on friendship and blocks. Both are resolved **once per request** into `actor.facts` (`shared/actor.ts` augments core's `ActorFacts`) — a policy predicate is synchronous and may not query | `policy.test.ts`, `shared/actor.test.ts` |
| A predicate reads its **`actor` argument**, never ambient state | the same rule runs in a page, a live query on a sync node, a job and an MCP tool, and only the argument exists in all four. `ctx.session` and `currentViewer()`-in-a-rule were the second answer to "who is the viewer?", and they returned `null` in production while every unit test installed one by hand | `friends/policy.test.ts` passes ONE actor and no context |
| A permission a route declares must be **declared and granted** | an undeclared one is `X_PERMISSION_UNKNOWN` — a 500 on the page, at request time. A declared one nobody grants is a gate with no key: reachable by URL, refused for every account that exists. Both shipped green | `app/auth/route-policy.contract.test.ts` |
| A wire the app owns is proved by a **request**, never by a unit test | `configureAuthenticator`, `viewerFor`, `withSession` and the `member` grant list each had a passing test over code with no caller. A resolver asserted in isolation proves the resolver | `app/auth/pipeline.contract.test.ts` — real pipeline, real cookie, real policy |
| `admin/admin` is view-only **by permission**, not by hiding buttons | it holds `admin:read` and never `admin:write`. One decision renders the button and answers the call — **true since 2026-08, and it was not before**: the toolbar rendered `<button type="button">` with no handler and no enclosing form on a page with `hydrate: 'never'`, while `invokeAdminAction` had no caller outside a test. The half that was missing is `apps/admin/api/admin-actions.ts`: each button is a `<form method="post">` submit carrying its row's id, and the action calls `invokeAdminAction`. `admin` inherits `member` so the operator is also a person; inheriting cannot leak a dashboard write, because every write gates on `admin:write` | `page.test.ts` (the form, not just the label), `api/admin-actions.contract.test.ts` (the POST, refused and audited) |
| A control on a `hydrate: 'never'` page is a **form submit** | `onClick` is markup on a page that ships no JavaScript. The dead toolbar above passed a render test for a release because the test asserted the label | `page.test.ts` asserts `method="post"` and the route, and asserts the read-only actor's HTML contains neither |

## What NOT to build

- A ninth primitive. Including for feature flags, uploads, captcha or search.
- A second authz path. The MCP tool, the HTTP route and the admin button share one policy object.
- A second answer to "who is the viewer?". There is one `Actor` — the framework's — and this app's
  relational facts ride on it through `ActorFacts`. Never a parallel viewer on `ctx`, in a service,
  or resolved a second time inside a rule.
- A `console` command that hands out a database URL. That is the `db-gateway`'s job, with an audit
  row. A second door is a second door even when it is convenient.
- Offset pagination. Cursors only — an insert before the offset shifts every later page.
- A tenant column, to "be safe". See the preventive rule above; it would fire on every feed read.
