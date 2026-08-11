# .claude/ — the base, not the prescription

`x new` writes this directory so an agent arrives with context and access on day one. It is a
**base**. The agents working in this repo write the code and extend this as they learn — a role
file, a command, a script are all things to add when the need appears, not a fixed set handed down.

| Path | What it is | Who extends it |
|---|---|---|
| `agents/` | one role per path, so two agents never write the same file. The file set **is** the lock | add a role when a new area appears |
| `commands/` | canned workflows: `/idea` → `/reset` → `/feature` | add one the second time you type the same sequence |
| `../.mcp.json` | reach: code structure, production data, production errors, this app's own tools | add a server when an agent reaches for it weekly |
| `../scripts/` | `scripts/<resource>/<verb>.ts`, catalogued by `scripts/help.ts` | **the agent decides what it needs.** The catalog is the directory, so it cannot drift |

## The rules that make a hive safe in one checkout

- Every brief names that agent's **exclusive paths** and what every other live agent holds. An
  agent needing a file it does not own **stops and reports** — it never edits across the line and
  never negotiates peer-to-peer.
- Two agents that must edit one file are **one slice**.
- **No git worktrees, no `git stash`, no git commands in a subagent.** Work is left uncommitted; the
  coordinator owns git and the merge.
- An agent runs the formatter and tests **only on the paths it edited**. The whole-repo gate
  (`bin/check`) is the coordinator's job, once, at the end.
- Never tell an agent to "ask the user" — it has no channel. Two legal moves: *decide and flag*, or
  *stop and report*.

## Writing these files

Instruct, do not explain. Lead with the rule, not the reason; give the reason only when it is not
obvious, and then as **mechanism + cost**. Tables beat paragraphs. Exact commands beat descriptions.
Targets: an agent file under 50 lines, a command under 30, `CLAUDE.md` under 600.

The highest-value thing you can write here is a **preventive rule** — one that bites before any
symptom. The test for including it: *would an agent write this bug without the rule?* If it would
only hit it while debugging, it belongs in `docs/gotchas.md` instead.
