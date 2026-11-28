# The agent kit — history

Why `.claude/` is managed. A record of the reasoning, never a current fact: the rules that hold are
in [`wiki/Agents.md`](../../wiki/Agents.md#the-agent-kit-skills-and-agents-every-app-gets) and in
`packages/cli/src/kit/registry.ts`, and where they disagree those win. Plan 101, slice 09,
`As of 2026-11`.

## The reversal of "nothing here is enforced"

Until 31.51 the scaffolded `.claude/README.md` said nothing in it was enforced by `bunx x verify`. It
was true and it was the defect: the commands and agents were written once by `x new` and never
again. A 31.22 app kept its 31.22 `/feature` — single agent, no hive, no PR, no design step — for
as long as it lived, and the framework could not tell an agent was working from instructions two
majors old. Axiom 3 (enforced, not documented) applies to the instructions an agent follows as much
as to the code it writes.

The kit is now a projection of one table (`KIT_ENTRIES`). `x new` writes it, `x kit` re-renders it,
`x verify`'s `manifest` step diffs it (`X_KIT_DRIFT`), `x upgrade` refreshes it. Three consumers of
one list cannot disagree about what a kit file is.

## Why skills, not commands

`.claude/commands/*.md` and `.claude/skills/<name>/SKILL.md` answer the same slash name, and a skill
silently shadows a command. Two formats for one job is the ambiguity axiom 1 refuses, so commands
stopped being scaffolded. A skill adds what a command lacks: a description the model matches on
(invoked without a slash), `paths:` scoping (`design-research` loads only under `apps/web/site/**`,
`packages/ui/**`, `**/*.scss`) and a body that may grow to a directory. `x upgrade` deletes an
unedited old command that matches a released form and renames an edited one to `app-<name>.md`,
reporting the diff, so no app loses its own work.

## Why managed, and what stays the app's

A managed file is the framework's claim about its own procedure (`x upgrade --dry-run`, `x design
research`, which MCP tool answers which question). It must follow the framework, so the app does not
edit it in place. Axiom 8 draws the line: the *structural* procedure ships; a *business* convention
is the app's, in `app-<name>` skills and agents the kit never touches (`X_KIT_SHADOWED` refuses a
reused managed name). `.claude/kit.json` is the app's switch (`"off": []`), and
`apps/web/DESIGN.md` is the app's from the day it is written.

## Why every name in a kit file is tested

A kit that names a command, flag, MCP tool or `X_*` code that does not exist sends an agent to a
dead end it cannot tell from its own mistake. `kit/drift.test.ts` resolves each against the
framework, and `kit/design-map.test.ts` imports each `@ultimat3/*` symbol the motion and effects
table advertises, so a dropped `Presence` fails a test, not an agent.

## The scaffold shapes adopt the same API

The kit tells an agent to use `@ultimat3/ui/motion` and `@ultimat3/effects`; the scaffold must not
contradict it. `--shape dashboard` ships one motion island (`Presence`, `stagger` + `inView`,
`layout`), and every shape's landing sits on a CSS-tier backdrop that costs no JavaScript. The
dashboard's route budget rose 60 kB → 78 kB for it, measured: the theme island is 35,964 B and the
motion island 40,875 B under Bun 1.4.4, and the two share no chunk.
