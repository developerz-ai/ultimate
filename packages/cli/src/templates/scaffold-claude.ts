// The `.claude/` directory `x new` writes: the harness half of what an agent reads, next to the
// `AGENTS.md`/`CLAUDE.md` half that already shipped. Every file lands in the app's own repo, shows
// up in the scaffold's diff and is deletable in one line — the framework ships the mechanism, the
// app keeps or replaces the convention. Nothing here reaches outside the project directory.

import type { GeneratedFile, NameSet } from './naming';
import { claudeAgentFiles } from './scaffold-claude-agents';
import { claudeCommandFiles } from './scaffold-claude-commands';

/**
 * Read-only commands and the two write commands whose blast radius is a file the gate checks.
 * Deliberately absent: `x db reset`, `x db backfill --write`, `x secrets`, `x deploy` — each is
 * destructive or reaches production, and an allowlist that covers them is a prompt nobody reads.
 */
const settings = (): string => `{
  "permissions": {
    "allow": [
      "Bash(bun install)",
      "Bash(bun test:*)",
      "Bash(bun run typecheck)",
      "Bash(bun run lint)",
      "Bash(bunx biome check:*)",
      "Bash(x verify:*)",
      "Bash(x test:*)",
      "Bash(x doctor:*)",
      "Bash(x g:*)",
      "Bash(x routes:*)",
      "Bash(x actions:*)",
      "Bash(x queries:*)",
      "Bash(x entities:*)",
      "Bash(x jobs ls:*)",
      "Bash(x jobs show:*)",
      "Bash(x tasks:*)",
      "Bash(x policy:*)",
      "Bash(x i18n check:*)",
      "Bash(x errors:*)",
      "Bash(x env check:*)",
      "Bash(x manifest:*)",
      "Bash(x db gen:*)",
      "Bash(x db migrate:*)",
      "Bash(x db branch:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bunx biome check --no-errors-on-unmatched --write \\"$CLAUDE_FILE_PATHS\\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
`;

const readme = (app: NameSet): string => `# .claude/

What Claude Code reads when it works on ${app.kebab}. Written by \`x new\`, owned by you from the
moment it lands: edit any file, or delete any file, and nothing in the app breaks. Nothing here is
enforced by \`x verify\`, and none of it reaches outside this directory.

| Path | What it costs | When you pay it |
|---|---|---|
| \`settings.json\` | nothing in context | read once per session; the hook runs per edit |
| \`commands/*.md\` | nothing until invoked | the file is read when you type \`/<name>\` |
| \`agents/*.md\` | one \`description\` line each | the body is read only when that agent is dispatched |

So the whole bundle is three description lines of standing cost. The rest is paid on use.

## What is here

| File | For |
|---|---|
| \`commands/feature.md\` | \`/feature\` — build or fix one thing end to end, gated on \`x verify\` |
| \`commands/planx.md\` | \`/planx\` — write a plan to \`docs/plans/\` for another agent to execute |
| \`commands/verify.md\` | \`/verify\` — run the gate and fix what it reports |
| \`agents/shape.md\` | the idea-stage pass: which primitive, which slice, or "do not build this" |
| \`agents/data.md\` | \`packages/db/\`, \`entity.ts\`, \`repo.ts\` |
| \`agents/server.md\` | actions, mutators, queries, jobs, tasks, policies, \`apps/web/api/\` |
| \`agents/web.md\` | \`apps/web/site/\`, pages, \`packages/ui/\`, tokens, i18n |

The agents are scoped by **boundary**, not by role — each one's brief is a file set it may write and
a line it may not cross. That is what makes two of them safe to run at once.

## What is deliberately not here

**No command that wraps \`x g\`.** \`x g <kind> <name>\` already is that command, and \`x g --help\` is
the only list of kinds — a slash command restating it is a second copy that drifts the first time a
kind is added.

**No size budget on this directory.** How much your app writes down is your convention, not the
framework's.

## The hook

One \`PostToolUse\` hook: \`bunx biome check --write\` on the file that was just edited. Scoped to that
file, so it costs milliseconds, and it settles formatting arguments before they reach a diff.

It is not a typecheck, because a *scoped* one does not exist: \`tsc\` needs the project, and \`x verify\`
takes no \`--only\` and no \`--skip\` by design — narrowing the gate would make "green" mean whatever
the caller chose. If you want types on every edit, \`bun run typecheck\` is the whole project and you
are choosing to pay for it.

## Where the rules live

\`AGENTS.md\` at the repo root — the conventions. \`.claude/\` is only the harness that reads them.
`;

/** The agent harness for a new app: three commands, four boundary agents, settings, and a map. */
export function claudeFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: '.claude/README.md', contents: readme(app) },
    { path: '.claude/settings.json', contents: settings() },
    ...claudeCommandFiles(app),
    ...claudeAgentFiles(app),
  ];
}
