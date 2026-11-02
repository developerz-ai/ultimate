# 22 — `x upgrade`: one major per run, a pointer to its section, the gate

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`cli`).

## Why
All six surveyed adopters sit behind latest (one at ^6, three at ^19, one at ^27, one at ^28). Majors 11→29 shipped in about nine weeks; `wiki/Upgrading.md` is 386 kB, 202 entries for 23→24 alone. `x upgrade` exits `X_NOT_IMPLEMENTED` (`cli/src/cmd-planned.ts:46`), whose fix `bun update --latest && x verify` jumps every major at once and hands an agent one red gate with no attribution.

## Decisions
| Question | Answer |
|---|---|
| Width | one major per run; `--to` inside the next major only. Each hop's gate attributes its red to that hop |
| Checklist | a pointer: section title and wiki URL. `wiki/` is not shipped (`cli/package.json:23`), and rows are prose. `x verify`'s findings carry the rest |
| Codemods, entry data, marker column | not in this slice. "No codemod ships" (`docs/history/major-sweeps.md:11`) stays true |
| Bun floor | a plain text edit in the command, because it moved in 25, 28 and 29 and blocks the hop. Sites: `engines.bun`, `.bun-version`, `packageManager`, `setup-bun`, `oven/bun:` tags. A digest-pinned image is reported, untouched |
| An app with no `x upgrade` yet | `bunx @ultimat3/cli@latest upgrade`, in the wiki. Nothing re-execs: a later major needs only its URL |
| State between runs | git. A dirty tree refuses, so a hop is one reviewable commit and the pins say where the walk stands |
| Commit | never. The agent commits |
| Guard copies | offered, never overwritten: the hop's own `x doctor --json` `data.guards` (`cli/src/doctor-guards.ts:57`) copied into the report, so templates match the hop. `x g guard <name> --force` stays the agent's decision |

## Files to change
- `packages/cli/src/cmd-planned.ts:46` — delete the row. `wiki/CLI-Reference.md:63` to shipped, `:1496` out.
- `packages/cli/src/cmd-upgrade-spec.ts`, `cmd-upgrade.ts` (new), `registry.ts` — flags, the walk, the report.
- `packages/cli/src/upgrade-plan.ts` (new) — pure: pins in, hop and section out. Refuses a mixed set.
- `packages/cli/src/upgrade-bun-floor.ts` (new) — pure text edit per pin site.
- `wiki/Upgrading.md:3283` — replace the planned section and its codemod and `openapi.json` rows with what ships. `docs/history/major-sweeps.md:11`, `wiki/Home.md`, `wiki/Installation.md`, `wiki/Getting-Started.md`, `docs/idea/15-risks.md`, `packages/cli/README.md`, `packages/cli/CLAUDE.md`. No `examples/dummy` use: a command, not a primitive.

## Steps
1. `bun run new-error-code` for each code below.
2. `x upgrade [--to <version>] [--dry-run] [--json]`. Refuse a dirty tree. Read every workspace's `@ultimat3/*` pins; mixed refuses. Next major: `bun pm view @ultimat3/cli versions --json` (probed: answers through `29.4.0`), newest release of it.
3. Write exact pins and the Bun floor from that release's `engines.bun`, then `bun install`.
4. From the installed CLI: `x manifest`, `x doctor --json`, `x verify --json`.
5. Report: `{ from, to, next, done, section: { title, url }, bun: { from, to, edited, manual }, guards: { missing, differs }, verify: { ok, summary, findings } }`. `done` is verify's verdict, and the exit code follows it. Human form prints the URL, then each finding's `fix:`.
6. `section.url`: `https://github.com/developerz-ai/ultimate/wiki/Upgrading#<anchor>` from the heading `<from> → <major>.0.0, entry by entry` (`wiki/Upgrading.md:78`). `from` is `<major-1>.x`, with three recorded exceptions: `4.1.0`, `3.0.0`, `2.0.0` (`:2831`, `:2911`, `:2962`).
7. `--dry-run`: pins, floor edits and section reported, nothing written, the gate not run.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UPGRADE_DIRTY_TREE` (off-socket) | uncommitted changes | `git status --short`, then commit or stash and re-run `x upgrade --json` |
| `X_UPGRADE_MIXED_PINS` (off-socket) | two `@ultimat3/*` versions across workspaces | `x upgrade --to <the higher version> --json` |
| `X_UPGRADE_HOP_TOO_WIDE` (off-socket) | `--to` skips a major | `x upgrade --to <next major's newest> --json` |
| `X_UPGRADE_REGISTRY_UNREACHABLE` (off-socket) | npm did not answer | `bun pm view @ultimat3/cli version`, then re-run |

## Tests
- `packages/cli/src/upgrade-plan.test.ts` (unit): `19.x` → next is 20; mixed refuses; `--to` skipping a major refuses; at latest answers done. Every `wiki/Upgrading.md` walkthrough heading from the file equals what the rule builds, so a heading edit fails here.
- `packages/cli/src/upgrade-bun-floor.test.ts` (unit): each pin site; second run changes nothing; digest kept and listed.
- `packages/cli/src/cmd-upgrade.test.ts` (unit, recording runner, git fixture): order is pins, install, manifest, doctor, verify; a dirty tree spawns nothing; a differing guard is reported and its file unchanged; red verify exits non-zero with `done: false`.
- `packages/cli/e2e/upgrade.e2e.test.ts`: one real hop on a scaffolded app against a local registry fixture, gate run. Command `bun test packages/cli/src/upgrade-plan.test.ts`.

## Semver
minor. A planned command ships; `X_NOT_IMPLEMENTED` for `x upgrade` goes away.

## Done when
- A scaffold pinned one major behind reaches the next with one command, and its report names the section and what the gate still says.
- A local guard edit survives: `git diff guards/` is empty after a hop.
- `bun run verify` green; `scaffold-smoke` green twice per shape.
