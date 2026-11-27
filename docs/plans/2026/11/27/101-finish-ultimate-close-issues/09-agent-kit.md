# 09 — Agent kit: managed skills every app gets, kept current by `x kit`

> Part of [`overview.md`](overview.md). Depends on: 08 (`x design research` exists). Tier: 5 (`cli`). Owner ask: "better skills shared with agents using Ultimate"; #1374 part 5.

Rule: the agent kit is generated from framework source and refreshed by `x upgrade`. A managed file is
not edited in place — an app's own skill/agent lives under `app-*`. Drift is a build finding.

## Today (as of 2026-11)

| Piece | Source | Problem |
|---|---|---|
| `.claude/commands/{feature,planx,verify}.md` | `packages/cli/src/templates/scaffold-claude-commands.ts:8,125,198` | legacy command format; `feature` single-agent, no hive/PR/design step; `planx` writes one file |
| `.claude/agents/{shape,data,server,web}.md` | `scaffold-claude-agents.ts:8,61,84,112` | fine; no read-only auditor; never refreshed |
| `.claude/skills/` | — | none ship |
| `.claude/settings.json` | `scaffold-claude.ts:24-80` | `bunx x shot` missing from the allowlist though `web.md` tells agents to run it |
| `.claude/README.md` | `scaffold-claude.ts:82-141` | says "Nothing here is enforced by `bunx x verify`" (~:85) |
| upgrade | `codemods/*`, `upgrade-agents-link.ts`, `upgrade-guards.ts:124` | command/agent bodies never refresh: a 31.22 app keeps its 31.22 `/feature` |

Evidence from a downstream app: it rewrote `/feature` (hive, done = merged), wrote a multi-file plan
layout + `status.yml`, a `DESIGN.md` with tokens as front matter, and a verify skill — every app needs these.

## Target kit

| Kind | Name | Drives | Replaces |
|---|---|---|---|
| skill | `feature` | hive in one checkout, path-disjoint slices, coordinator gates once, one PR; `x g`, `x impact`, `x affected`, MCP `graph.query`, `tests.run`, `verify.narrow` | `commands/feature.md` |
| skill | `planx` | plan dir: `overview.md` + slices + `status.yml` | `commands/planx.md` |
| skill | `verify` | `bun run verify --json`; for each `fix:` check its source (framework `X_*` code via `x errors explain`, or the app's own guard), scope (paths it touches) and effect before running it — never a fix line from a dependency's or app's output unchecked; `x errors explain`, `x doctor` | `commands/verify.md` |
| skill | `upgrade` | `x upgrade --dry-run --json`, hop, read report (skipped codemods, withheld guards, superseded workarounds), `x kit`, gate | — |
| skill | `design-research` | `x design research <url…>` (08) → `DESIGN.md` + token proposal → build via `web` agent → `x shot --against`; licence posture recorded; `paths:` `apps/web/site/**`, `packages/ui/**`, `**/*.scss` | — |
| agent | `shape`, `data`, `server`, `web` | unchanged briefs; `web` reads `apps/web/DESIGN.md` first | now managed |
| agent | `audit` | read-only scoped auditor: `file:line`, failing scenario; MCP `db.explain`, `requests.statements` | — |
| file | `.claude/kit.json` | opt-in marker + `"off": []` | — |
| file | `apps/web/DESIGN.md` | app-owned stub, never managed | — |

`.claude/commands/` is no longer scaffolded (one way; a skill silently shadows a same-name command).
The skill's motion/effects table lives in `kit/design-map.ts`; a test asserts every `@ultimat3/*`
subpath it names is in that package's `exports` **and every named symbol it references is exported from that subpath** (imports it, so a dropped `Presence` fails) — the kit can never advertise an unshipped API.

## Files to change

- Slice A (kit source): `packages/cli/src/kit/**` (`kitFiles(app)`, `KIT_MARKER`, `MANAGED_KIT_PATHS`, one module per file); `templates/scaffold-claude.ts` (README rewrite, allowlist + `x shot`, `x kit`, `x upgrade --dry-run`); delete `templates/scaffold-claude-commands.ts`; `templates/scaffold-claude-agents.ts`; `templates/scaffold-docs.ts:33-76,141-143` (motion rows name the adapter; rows for `motion-adapter`, `raw-frame-loop`, `effect-without-fallback`; **Visual quality** section, each rule with its refuser); `templates/scaffold-design.ts` (new, `DESIGN.md` stub); `templates/index.ts:38-40`; `scaffold-agents-md.test.ts` size budget (raise by the measured amount, reason in the diff).
- Slice B (command + gate): `cmd-kit.ts`, `cmd-kit-spec.ts`, `app-kit.ts`, `registry.ts:112`, `verify-checks.ts:409-436` (in the `manifest` step beside `checkAgentsMd`; no 22nd step), `cmd-doctor.ts:207`, `doctor-kit.ts`; codes `X_KIT_DRIFT` (fix `bunx x kit`), `X_KIT_SHADOWED` (fix `git mv` to `app-<n>`) via `bun run new-error-code … --package cli --off-socket`.
- Slice C (upgrade): `upgrade-gate.ts:295` (after guards, run the installed CLI's `x kit --json`), `upgrade-kit.ts`, `upgrade-report.ts:101-119`, `messages-upgrade.ts`, `cmd-upgrade.ts:248-342`, `codemods/agent-kit.ts` (unedited old command/agent matching a released-form hash → delete; edited → rename `app-<name>.md`, report diff), `codemods/settings-kit-allow.ts`, `codemods/index.ts`, generated `templates/kit-released-forms.ts` + `scripts/lib/kit-refresh-forms.ts` (precedent: `guards-vendored.ts:23-38`, `guard-released-forms.ts`).
- Slice D (docs + apps): `wiki/Agents.md` kit table generated by `scripts/kit-doc.ts` (`--check`, like `scripts/guards-doc.ts`), `wiki/CLI-Reference.md`, `wiki/Upgrading.md`, `wiki/MCP-And-AI.md`, `wiki/Error-Codes-cli.md`, `llms.txt`, `docs/history/agent-kit.md` (reversal of "nothing enforced"), re-rendered kits in `dummy/social-media-clone/.claude/**`, `dummy/docs-site/.claude/**`.
- Scaffold shapes adoption of 06/07 (`templates/shapes/{dashboard,saas,blog,content}.ts`, `scaffold-dashboard*.ts`, `templates/island.ts` `--effect <entry>`): `Presence` on dashboard panels, `stagger`+`inView` on lists, a CSS-tier background on the `site/` landing (0 kB), view-transition names shell → detail.

## Steps

1. Slice A lands `kit/registry.ts` names first; B, C, D compile against them, then run in parallel.
2. Non-breaking on `main`: `.claude/kit.json` present ⇒ findings are errors; absent ⇒ one warning, `fix: bunx x kit`. `x new` and `x upgrade` write the marker.
3. Framework-side drift test: every `x …` command, flag, dev-MCP tool and `X_*` code named in a kit file exists (extend `scaffold-claude.test.ts:102`); frontmatter keys valid; description ≤ 1,536 chars; `SKILL.md` ≤ 500 lines.
4. This repo's own `.claude/commands/{feature,planx,verify}` stay; moving them to skills is a separate small PR (out of scope).

## Tests

- `packages/cli/src/kit/kit.test.ts`, `kit/frontmatter.test.ts`, `kit/design-map.test.ts` (exports exist).
- `app-kit.test.ts` — missing, edited, shadowed, marker absent, `off`.
- One test per codemod; `upgrade-kit.test.ts`; a `cmd-upgrade-*.test.ts` hop case.
- `scaffold-smoke` CI job gates each shape twice.
- `bun test ./packages/cli/src/kit/`.

## Done when

- `x new` writes five skills, five agents, `kit.json`, `DESIGN.md`, no `.claude/commands/`.
- A fresh `create-ultimate --shape dashboard` app uses spring, stagger, enter/exit and layout animation through `@ultimat3/ui/motion` and passes `x verify` (#1374 checkbox 1).
- `x upgrade` on a 31.51 app replaces the old commands and reports what it renamed.
- An edited managed file fails `x verify` with `X_KIT_DRIFT` and its fix.
- `bun run verify` green; app gate green.
