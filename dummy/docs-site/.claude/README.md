# .claude/

What Claude Code reads when it works on docs-site. Written by `x new`, owned by you from the
moment it lands: edit any file, or delete any file, and nothing in the app breaks. Nothing here is
enforced by `bunx x verify`, and nothing here reaches outside this repository.

One thing in it does *write*: the `PostToolUse` hook in `settings.json` reformats each file an agent
edits, in place, the moment it is saved. That is the only thing here that touches your code on its
own — see [The hook](#the-hook), and delete the `hooks` block if you would rather format by hand.

| Path | What it costs | When you pay it |
|---|---|---|
| `settings.json` | nothing in context | read once per session; the hook runs per edit |
| `hooks/format-edited.ts` | nothing in context | runs after each edit, on that one file |
| `commands/*.md` | nothing until invoked | the file is read when you type `/<name>` |
| `agents/*.md` | one `description` line each | the body is read only when that agent is dispatched |

So the whole bundle is three description lines of standing cost. The rest is paid on use.

## What is here

| File | For |
|---|---|
| `commands/feature.md` | `/feature` — build or fix one thing end to end, gated on `bun run verify` |
| `commands/planx.md` | `/planx` — write a plan to `docs/plans/` for another agent to execute |
| `commands/verify.md` | `/verify` — run the gate and fix what it reports |
| `agents/shape.md` | the idea-stage pass: which primitive, which slice, or "do not build this" |
| `agents/data.md` | `packages/db/`, `entity.ts`, `repo.ts` |
| `agents/server.md` | actions, mutators, queries, jobs, tasks, policies, `apps/web/api/` |
| `agents/web.md` | `apps/web/site/`, pages, `packages/ui/`, tokens, i18n |

The agents are scoped by **boundary**, not by role — each one's brief is a file set it may write and
a line it may not cross. That is what makes two of them safe to run at once.

## What is deliberately not here

**No command that wraps `bunx x g`.** `bunx x g <kind> <name>` already is that command, and `bunx x g --help` is
the only list of kinds — a slash command restating it is a second copy that drifts the first time a
kind is added.

**No size budget on this directory.** How much your app writes down is your convention, not the
framework's.

## The hook

One `PostToolUse` hook, `.claude/hooks/format-edited.ts`: `bunx biome check --write` on the file that was just
edited, named by the JSON the harness sends on stdin. **`--write` means it rewrites that file in
place** — the same safe fixes `biome check --write .` would make repo-wide, but your working tree
does change after every agent edit. Scoped to one file, so it costs milliseconds, and it settles
formatting arguments before they reach a diff. What biome cannot fix is shown to the agent at once,
with the command that re-checks the file, instead of surfacing later as a red `lint` step.

It is not a typecheck, because a *scoped* one does not exist: `tsc` needs the project, and even
`bunx x verify --only typecheck` checks the whole tree — and says `NOT A GATE RUN`, because green
means the run with no flag. There is no `--skip`. If you want types on every edit, `bun run typecheck`
is the whole project and you are choosing to pay for it.

## Where the rules live

`AGENTS.md` at the repo root — the conventions. `.claude/` is only the harness that reads them.
