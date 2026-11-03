# 42 — Adoption: contributors, governance, telemetry, third-party packages

> Part of [`overview.md`](overview.md). Depends on: [`37-scrub-adopter-names`](37-scrub-adopter-names.md) (names stay there), [`42-adopt-stability`](42-adopt-stability.md). Tier: docs, `scripts/`, `.github/`; `http` (2) for one link.

## Why
Checked 2026-11-02.

| A stranger checks | Found |
|---|---|
| community profile | 75%: no code of conduct |
| ask a question | `.github/ISSUE_TEMPLATE/config.yml:7` links `/discussions`: **404**, and `blank_issues_enabled: false`, so a question has nowhere to go |
| something small to do | label `good first issue` exists; `gh issue list --label` returns 0 of any state |
| who decides | no governance file. `README.md:387`: "the owner comes back once or twice a year". `README.md:396`: breaks are "the bot's call". Latest 200 merged PRs since 10-01, Dependabot excluded: two authors, the owner and the bot |
| can I trust a bus-factor-one, AI-run project | nothing states who holds npm publishing, what happens if the bot stops, or that the licence stays |
| contribute | `CONTRIBUTING.md:150` "a minor bump before 1.0", at major 29. `.claude/commands/feature.md:123,154` requires an internal merge tool a contributor lacks |
| does `x` phone home | no: `strace -e connect` on `x doctor` shows only local port probes on 3000 and 3001; no analytics host in `cli/src`. Written down nowhere, enforced nowhere |
| vendor marks on a stranger's site | `http/src/error-page.ts:22,178`: the default error page links this org's homepage. A scaffold's own 404 has no such link (probe: no external `href`), so it reaches apps with no page of their own |
| publish a wrapper | probe: an npm-shaped package in `node_modules` exporting `entity()` and a factory, re-exported from `apps/web/app/thing/entity.ts`: `x doctor` saw its table (`X_DB_SCHEMA_UNMIGRATED … "acme_log"`), `boundaries` green. **The mechanism works and is undocumented**; `wiki/Building-Your-Own-Base.md:18-19` admits manifest, admin and MCP projections were never run |
| which version range | `CHANGELOG.md:5`, `wiki/Upgrading.md:3`: "pin exactly". The scaffold writes `^29.4.0` (`package.json`). A third party has no rule |

No private registry, `bunfig.toml` holds none. No hard-coded internal host beyond this repo's own domain.

## Decisions
| Question | Answer |
|---|---|
| Telemetry | none. If ever added: opt-in, off by default, a major. Enforced by a guard |
| Governance | `GOVERNANCE.md`, short, true today: owner, bot authority and limits, npm path (OIDC, no personal token), continuity: MIT, anyone may fork; owner names a successor in writing. This slice commits a draft; signing and publishing are the final owner step |
| Code of conduct | a standard code-of-conduct text, adopted by link, with a reporting address the owner picks |
| Discussions | enabled: a question otherwise cannot be asked. The repository switch is in the final owner step; config stays |
| Good first issues | at least 5 at launch, written by the bot with file:line and the failing-test idea. Drawn from `wiki/Known-Gaps.md`, none touching CI or release |
| Error-page link | keep "Built with Ultimate" to the repository; drop the org homepage link. The app's own page replaces it, as today |
| Marketplace, registry, plugin API | none (axiom 8). Convention: unscoped `ultimate-<name>`, keyword `ultimate-package`; `npm search` is the directory. `@ultimat3/` is reserved |
| Third-party ranges | a wrapper declares `peerDependencies` at `^<major>` on what it imports, never `dependencies` |
| "Pin exactly" | docs corrected: apps take `^` and the lockfile pins, as every scaffold has. Lockstep stays the rule among `@ultimat3/*` |
| Community package list | a wiki page by PR, only after one exists |
| `.claude/`, `.dz/` tracked | stay: both are honest. `.claude/commands/feature.md` states `gh pr merge --squash` as the path, the internal tool as optional |

## Files to change
- `GOVERNANCE.md`, `CODE_OF_CONDUCT.md` (new); `README.md` AI-maintained section; `SECURITY.md:18` who acknowledges.
- `.github/ISSUE_TEMPLATE/config.yml`, `question` routing; `CONTRIBUTING.md:150`, `:34` step list source; `wiki/Contributing.md`.
- `.claude/commands/feature.md:123,154`.
- `packages/http/src/error-page.ts:20-23,178` + test, `packages/http/src/index.ts:65` — the constant loses `homepage`. Changed exported constant: breaking.
- `scripts/cli-outbound.ts` (new) + test, `scripts/verify.ts:343` — the telemetry guard.
- `wiki/FAQ.md` — "Does Ultimate collect anything?". `wiki/CLI-Reference.md` — one line.
- `wiki/Building-Your-Own-Base.md` — a new section, "Publish it"; re-run claims; drop the "not re-run" paragraph.
- `CHANGELOG.md:5`, `wiki/Upgrading.md:3`, `wiki/Installation.md:183` — ranges.
- `packages/cli/src/third-party-wrapper.test.ts` (new) + fixture — the proof.

## Steps
1. Telemetry guard: list every outbound host literal in `packages/cli/src` non-test files against a small allowlist with a `why` per row; `.invalid` and localhost are exempt, and `fetch` to an unlisted literal is refused. Write the FAQ answer citing it.
2. Third-party fixture: a package outside the workspace, peer on `^<major>`, exporting an entity, a factory, an action with `mcp`, a job. An app imports it. Assert: `x entities`, manifest row, `tools/list` holds the action, its policy refuses, job runs. Failure here is a bug to fix in this slice or file as a new row.
3. `wiki/Building-Your-Own-Base.md` "Publish it": naming, peer rule, what a consumer's `x verify` sees, no `tier` for third parties, guards are copied not imported, a `package.json` sample. Third-party starters: a repository a person copies; the README says so.
4. `GOVERNANCE.md`: true statements only; no promise a bot cannot keep. Security ack names who actually answers.
5. Five good first issues prepared as text in the PR. **Final owner step, since each is outward-facing**: enables discussions, files the issues (or tells the bot to), signs and publishes governance, supplies the conduct address.

## Error codes
`bun run new-error-code`, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_CLI_OUTBOUND_UNDECLARED` | a non-test `cli` file reaches a host not on the allowlist | delete the call, or add a row in `scripts/cli-outbound.ts` with its `why` |

## Tests
- `scripts/cli-outbound.test.ts`: a fixture with an analytics URL fails; today's tree passes.
- `third-party-wrapper.test.ts`: fails if a registered primitive from outside the workspace drops out of the manifest or the tool list.
- `error-page` test: no org homepage in output.
- `bun test scripts/cli-outbound.test.ts`

## Semver
Breaking in one line only: `ERROR_PAGE_LINKS.homepage` removed. Upgrading entry: "stop reading it; the page still links the repository." Held to the next window. All else no API change.

## Done when
- Community profile reports 100%; no link in `.github/` answers 404.
- FAQ states no telemetry and names the guard.
- `third-party-wrapper.test.ts` green; the "not re-run" paragraph is gone.
- `grep -n 'pin' CHANGELOG.md | sed -n 1p` matches what the scaffold writes.
