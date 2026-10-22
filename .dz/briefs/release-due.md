# Brief: is a release due?

Weekday checkup, fired by `schedules: release-due` in `.dz/maintainer/maintainer.yml`. Ultimate
releases like a maintained project: when merged work that ships has waited for a release, it gets
one. The decision is a command, never a judgement made here.

## Run

```bash
git fetch --tags origin && bun run scripts/release-due.ts --json
```

Fetch tags first — a shallow or tagless clone (CI's is both) holds no reachable `v*` tag, and the
run refuses rather than guess. A refusal (`ok:false`) still prints the complete JSON envelope,
then exits 1: `report()` renders the envelope and ends `process.exit(result.ok ? 0 : 1)`
(`scripts/lib/log.ts:153-155`). So this step must never sit under `set -e` — a refusal would end
the checkup on the exit code before the envelope is read. Branch on `data.due`; on `ok:false`,
read the envelope instead — every finding carries its own `fix`, and the second git refusal,
`X_RELEASE_WINDOW_UNREADABLE` (tag found, window unreadable), names
`git fetch --unshallow --tags origin; bun run scripts/release-due.ts --json`.

| `data.due` | `data.reason` | What to file |
|---|---|---|
| `false` | `nothing_ships` | nothing |
| `false` | `settling` | nothing — an org member may still release their own work; next checkup decides |
| `false` | `major_needs_a_maintainer` | nothing, unless no open issue already says a major is pending: then one issue listing `data.breaking`, for a maintainer |
| `true` | — | one ask: **Release `<data.next>`**, listing `data.shipping` |

## The ask, when due

Title `Release <next>`. Body, verbatim steps for the box that takes it:

1. `bun run scripts/release-due.ts --json` again on fresh `main` — still due, same `next`, or stop.
2. A Dependabot-only window adds nothing under `## [Unreleased]` in `CHANGELOG.md`: add a
   `### Changed` line naming each bumped runtime dependency and its new range first.
3. Run the `data.command` it printed (`bun run scripts/release.ts --version <next>`), then
   `bun run verify`.
4. One PR, `chore: release <next>`, nothing else in the diff. It merges on green like any PR.
5. Merging it is the release: `.github/workflows/release-tag.yml` tags `v<next>` (annotated),
   publishes the GitHub Release and dispatches `release.yml`. Never tag, never `gh release create`,
   never `npm publish` by hand — `PUBLISHING.md`. The canonical close is the workflow's own
   `close the release ask` step — by the job that did the tag, on the exact title
   `Release <next>`. The PR body carrying `Fixes #<ask>` is a backstop, not the path:
   `scripts/release.ts` prints the ask link when one is open.

Never file a second ask while one titled exactly `Release <next>` is open — byte-for-byte:
`release <v> did not publish`, `Release <v> (#N)`, `Release <other>` are not twins (the version
is the whole title, no trailing prose). The box fetches candidates with
`gh issue list --state open --search "Release <next> in:title"`, where `<next>` is `data.next` from
the run above — substitute the version before running it — then post-filters them by exact title
match.

## Evidence: one live run on this checkout

`bun run scripts/release-due.ts --json`, 2026-10-22T01:02:38Z, exit 0. This checkout had tags
fetched, so this is an `ok:true` answer, not a refusal:

```json
{"ok":true,"script":"release-due","summary":"no release due (settling): the oldest shipping commit is younger than 24h, so its author may still release it: due at 2026-10-22T15:17:08.000Z","findings":[],"data":{"lastTag":"v27.13.2","stamped":"27.13.2","settleHours":24,"shipping":[{"sha":"7ebb9c3a39adb5ebe8e4891a2fa5123791766097","subject":"fix(cli): expose `headSha` on every `x ci` run row; document `ok: true` means \"no failed run\" (#826)","author":"developerz-ai[bot]","committedAt":1792627464,"packages":["cli"]},{"sha":"c56f7d97a130d2f67db08c6e7a03cea23336ad12","subject":"Give Finding.at one meaning: a path an agent can open (#821)","author":"developerz-ai[bot]","committedAt":1792595828,"packages":["cli"]}],"inert":9,"notes":["[Unreleased] in CHANGELOG.md is empty, so the release notes would be the commit subjects alone. Write them under `## [Unreleased]` before bumping."],"breaking":[],"bump":"patch","next":"27.13.3","due":false,"reason":"settling","detail":"the oldest shipping commit is younger than 24h, so its author may still release it: due at 2026-10-22T15:17:08.000Z","dueAt":"2026-10-22T15:17:08.000Z"}}
```
