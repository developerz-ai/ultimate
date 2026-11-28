// The `.claude/` directory `x new` writes: the harness half of what an agent reads, next to the
// `AGENTS.md`/`CLAUDE.md` half. The skills and agents are the managed kit (`../kit/registry.ts`):
// `x kit` re-renders them and the gate refuses an edit in place, so an app's own variant lives
// under `app-*`. Settings, the hook and this README are the app's from the moment they land.

import { KIT_MARKER, kitFiles, kitMarkerFile } from '../kit/registry';
import type { GeneratedFile, NameSet } from './naming';
import { claudeHookFile, HOOK_COMMAND, HOOK_PATH } from './scaffold-claude-hook';

/**
 * Read-only commands and the two write commands whose blast radius is a file the gate checks.
 * Spelled `bunx x`, the form that runs with no global `x` and the one the generators print.
 * Deliberately absent: `x db reset`, `x db backfill --write`, `x secrets`, `x deploy` — each is
 * destructive or reaches production, and an allowlist that covers them is a prompt nobody reads.
 *
 * The read-only commands the app's own docs tell an agent to run (`x impact` before every edit,
 * `x graph`, `x affected`, `x exercise`, `x mcp tools`) are here too: a prompt on one is a stall.
 * So are the ones the kit's skills run: `x shot` (the `web` agent and `design-research`), `x kit`
 * (writes only managed `.claude/` files) and `x upgrade --dry-run` (writes nothing) — never the hop
 * itself, which moves pins and installs.
 *
 * The hook is the one part of the bundle that ACTS: `--write` rewrites the file just edited, in
 * place. JSON takes no comment (the lesson `scaffold-repo.ts`'s `biome.json` already paid for), so
 * the disclosure lives in `.claude/README.md` under "The hook" — and a test pins it there.
 */
const settings = (): string => `{
  "permissions": {
    "allow": [
      "Bash(bun install)",
      "Bash(bun test:*)",
      "Bash(bun run verify:*)",
      "Bash(bunx @biomejs/biome check:*)",
      "Bash(bunx x verify:*)",
      "Bash(bunx x test:*)",
      "Bash(bunx x heavy:*)",
      "Bash(bunx x stop:*)",
      "Bash(bunx x doctor:*)",
      "Bash(bunx x g:*)",
      "Bash(bunx x routes:*)",
      "Bash(bunx x actions:*)",
      "Bash(bunx x queries:*)",
      "Bash(bunx x entities:*)",
      "Bash(bunx x jobs list:*)",
      "Bash(bunx x jobs show:*)",
      "Bash(bunx x tasks:*)",
      "Bash(bunx x policy:*)",
      "Bash(bunx x i18n check:*)",
      "Bash(bunx x errors:*)",
      "Bash(bunx x docs:*)",
      "Bash(bunx x impact:*)",
      "Bash(bunx x graph:*)",
      "Bash(bunx x affected:*)",
      "Bash(bunx x exercise:*)",
      "Bash(bunx x i18n sync:*)",
      "Bash(bunx x fix boundary:*)",
      "Bash(bunx x mcp tools:*)",
      "Bash(bunx x env check:*)",
      "Bash(bunx x manifest:*)",
      "Bash(bunx x db gen:*)",
      "Bash(bunx x db migrate:*)",
      "Bash(bunx x db branch:*)",
      "Bash(bunx x shot:*)",
      "Bash(bunx x kit:*)",
      "Bash(bunx x upgrade --dry-run:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK_COMMAND.replaceAll('"', '\\"')}",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
`;

const readme = (app: NameSet): string => `# .claude/

What Claude Code reads when it works on ${app.kebab}. Two kinds of file live here:

| Kind | Paths | Who owns it |
|---|---|---|
| **managed** | \`skills/{feature,planx,verify,upgrade,design-research}/SKILL.md\`, \`agents/{shape,data,server,web,audit}.md\` | the framework: \`bunx x kit\` writes them, \`bunx x upgrade\` refreshes them |
| **yours** | \`settings.json\`, \`hooks/\`, \`kit.json\`, this README, anything named \`app-*\` | you, from the moment it lands |

**The managed kit is enforced by \`bunx x verify\`.** Edit a managed file in place and the gate
fails with \`X_KIT_DRIFT\`; its fix, \`bunx x kit\`, puts the shipped text back. To change one, copy
it to \`skills/app-<name>/SKILL.md\` or \`agents/app-<name>.md\`, then add the managed name to
\`"off"\` in \`${KIT_MARKER}\`. A file of yours that takes a managed name is \`X_KIT_SHADOWED\`.
\`${KIT_MARKER}\` is the opt-in: with it, kit findings are errors; without it, one warning.

One thing here *writes*: the \`PostToolUse\` hook in \`settings.json\` reformats each file an agent
edits, in place, the moment it is saved — see [The hook](#the-hook).

| Path | What it costs | When you pay it |
|---|---|---|
| \`settings.json\` | nothing in context | read once per session; the hook runs per edit |
| \`hooks/format-edited.ts\` | nothing in context | runs after each edit, on that one file |
| \`skills/*/SKILL.md\` | one \`description\` line each | the body is read when the skill is invoked |
| \`agents/*.md\` | one \`description\` line each | the body is read only when that agent is dispatched |

## What is here

| File | For |
|---|---|
| \`skills/feature\` | \`/feature\` — a hive in this one checkout: path-disjoint slices, one gate, one PR, done when merged |
| \`skills/planx\` | \`/planx\` — a plan directory under \`docs/plans/\`: overview, slices, \`status.yml\` |
| \`skills/verify\` | \`/verify\` — run the gate; check each \`fix:\` line's source, scope and effect before running it |
| \`skills/upgrade\` | \`/upgrade\` — one major per hop, the report read, the kit refreshed, the gate |
| \`skills/design-research\` | \`/design-research\` — measure a reference, write \`apps/web/DESIGN.md\`, build, compare |
| \`agents/shape.md\` | the idea-stage pass: which primitive, which slice, or "do not build this" |
| \`agents/data.md\` | \`packages/db/\`, \`entity.ts\`, \`repo.ts\` |
| \`agents/server.md\` | actions, mutators, queries, jobs, tasks, policies, \`apps/web/api/\` |
| \`agents/web.md\` | \`apps/web/site/\`, pages, \`packages/ui/\`, tokens, i18n — reads \`apps/web/DESIGN.md\` first |
| \`agents/audit.md\` | read-only review of the paths it is given: \`file:line\` and the scenario that fails |

The agents are scoped by **boundary**, not by role — each one's brief is a file set it may write and
a line it may not cross. That is what makes two of them safe to run at once.

## What is deliberately not here

**No \`commands/\`.** A skill of the same name silently shadows a command, so there is one way:
skills.

**No skill that wraps \`bunx x g\`.** \`bunx x g <kind> <name>\` already is that command, and
\`bunx x g --help\` is the only list of kinds.

## The hook

One \`PostToolUse\` hook, \`${HOOK_PATH}\`: the installed \`biome check --write\` on the file that was just
edited, named by the JSON the harness sends on stdin. **\`--write\` means it rewrites that file in
place** — the same safe fixes \`biome check --write .\` would make repo-wide, but your working tree
does change after every agent edit. Scoped to one file, so it costs milliseconds, and it settles
formatting arguments before they reach a diff. What biome cannot fix is shown to the agent at once,
with the command that re-checks the file, instead of surfacing later as a red \`lint\` step.

It is not a typecheck, because a *scoped* one does not exist: \`tsc\` needs the project, and even
\`bunx x verify --only typecheck\` checks the whole tree — and says \`NOT A GATE RUN\`, because green
means the run with no flag. There is no \`--skip\`. Run it once, when the work is otherwise done: it
queues for the machine's memory, which \`bun run typecheck\` does not.

## Where the rules live

\`AGENTS.md\` at the repo root — the conventions. \`.claude/\` is only the harness that reads them.
`;

/** The agent harness for a new app: settings, the hook, a map, the kit marker and the managed kit. */
export function claudeFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: '.claude/README.md', contents: readme(app) },
    { path: '.claude/settings.json', contents: settings() },
    claudeHookFile(),
    kitMarkerFile(),
    ...kitFiles(app),
  ];
}
