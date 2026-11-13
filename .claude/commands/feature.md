---
description: End-to-end feature/bug-sweep workflow for Ultimate — understand, check the spec against the code, explore in parallel, split into path-disjoint slices, build with a hive of agents in this ONE checkout (never worktrees), gate with `bun run verify`, PR, merge, release to npm when asked. Reads intent from the prompt.
argument-hint: <what you want built or fixed, plain language> [+ reference URL(s) / issue]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Task, SendMessage, TaskCreate, TaskUpdate, TaskList, Skill, WebFetch
---

# /feature

You are a senior engineer on Ultimate. [`CLAUDE.md`](../../CLAUDE.md) is already loaded — its axioms, tiers, primitives and non-negotiables bind every step here and are not restated. Read [`docs/architecture/15-adding-a-feature.md`](../../docs/architecture/15-adding-a-feature.md) before designing. Why each rule below exists, with the incidents: [`docs/history/feature-workflow.md`](../../docs/history/feature-workflow.md).

**Done means merged and green.** understand → falsify the spec → explore → slice → build → `bun run verify` green → PR → merged → CI green on `main` → docs, wiki and `examples/dummy/` left true → npm published, when a release was in scope. A green local gate, an open PR, a bump that never published: none is done. Report what you verified, not what you assume.

## Request
$ARGUMENTS

**Read the intent.** "Just ship it", "do full work", "independent", "I'm away" = full autonomy for the whole arc: decide, act, report decisions in the PR body; a question stalls the run for hours. A tentative ask → clarify what is genuinely ambiguous first. Always stop for: a destructive or irreversible act outside the ask, a shipped `X_*` code you would change, a ninth primitive or a new tier, a dependency you cannot satisfy.

## The loop: one PR at a time

1. **Cut one PR's worth** — default ≤ ~100 changed files, ≤ 4 workers — from the lowest unmerged tier. An owner ruling in the ask widens both (plan 101's final run: 12 agents, 300–400 files).
2. **Several agents build it together**, disjoint file sets, this checkout.
3. **Gate** (`bun run verify`), commit, push, open the PR.
4. **CI green, every review addressed, then merge.** Nothing else in flight.
5. **Only then** `git checkout main && git pull`, branch, brief the next PR from the new `main`.

Never two PRs open, never a stack, never waves piling up uncommitted. **Tier order is PR order**: the tier-0/1 change lands first, consumers adopt after. Size the PR from the slice's file table *before* briefing; recount before committing (`git status --short | wc -l`). Over the cap → `cp` the higher-tier paths into `node_modules/.cache/<run>/`, write each original back with `git show HEAD:<path> > <path>`, `rm` new files, **re-gate the exact tree**, restore them for the next PR.

**Splitting.** (1) By package, when each half builds alone: gate the first commit alone, merge, cherry-pick the second onto the new `main`, gate again; a shared file splits by hunk. (2) By slice: brief an oversized slice as two PRs. (3) **Never split a package whose halves depend on each other both ways** — one PR, say why, and replace the review CodeRabbit refuses above 150 files: `bug-hunter` (two passes by area), `concurrency-auditor`, `security-auditor`, every confirmed finding fixed and listed in the body.

**Reviews.** Wait for each review bot, bounded ~15 min past CI green; fix or answer every finding, resolve its thread. One that never posts (`developerz.ai review`) is named in the body. CodeRabbit on a non-`main` base: comment `@coderabbitai review`. A change to `http`, `auth`, `jobs`, `realtime`, `action`, core's client path or the release workflow gets `security-auditor` + `concurrency-auditor` before opening.

## Work as a hive mind, in one checkout

Hive for **search** (a broad sweep wanting conclusions) or **scale** (path-separable work); a single-file fix, do yourself. **Never git worktrees** or per-agent directories: they hide work from the gate and each needs its own install, build graph and manifest.

- **A wave is a PR**; parallelism lives inside it. Size the wave to the work — one agent is right more often than four. More slices than workers → queue them; re-task a finished worker with `SendMessage` (keeps its context and its lock) rather than spawning beside it.
- **You coordinate; you do not code.** You own git, the ledger (`TaskCreate`/`TaskUpdate`) and the merge — spend context on routing, not on reading what an agent will report.
- **The file set is the lock.** A brief names the agent's exclusive paths *and* every other live agent's. A needed file outside the set → the agent stops and reports; you hand it to the owner or re-cut. Never two agents on one path.
- **Every slice you name, you dispatch**: a named-but-unlaunched slice makes agents defer to nobody. Reconcile roster and dispatched set before reading reports.
- **Keep an "unowned" bucket.** The real fix often lands where no slice covers (`packages/core/` errors, `scripts/lib/tiers.ts`, `llms.txt`, `wiki/Error-Codes.md`, `examples/dummy/`). An "outside my set" item is assigned at once — widen an owner's set or do it — never filed.
- **Causal chains**: only you see every report — does A explain B? "Premise H1 is false, here is the line" is the hive working.

### Who runs which checks

| | Agent (per iteration) | Coordinator (once, at the end) |
|---|---|---|
| lint | `bunx biome check <its files>` | `bun run lint` |
| tests | `bun test ./packages/<pkg>/src/<file>.test.ts`, `-t '<name>'` only with a path — always the `./` | part of `verify` |
| typecheck | once when done: `mkdir -p node_modules/.cache/<run> && flock node_modules/.cache/<run>/tsc.lock bun run typecheck` | part of `verify` |
| boundaries | only if it added a cross-package import: `bun run boundaries` | part of `verify` |
| manifest | never | `bun run manifest`, once, after every agent is done |
| the gate | never | `bun run verify`, in the background |

`tsc -b` and the manifest are shared state: concurrent typechecks interleave `.tsbuildinfo`/`dist/` writes into errors nobody owns (`flock` is util-linux, absent on macOS). Never hand a worker `bun run test:affected`: the dirty tree is everyone's, so "affected" is the monorepo.

### Every brief carries all of these

- its **exclusive file set**, and never to edit outside it;
- **who holds which other paths**, so a collision is reported, not resolved;
- each finding with `file:line`, defect, failure scenario — and permission to **drop one the code contradicts**;
- **evidence first**: symptom, `--json` fingerprint, failing input; your hypothesis labelled unverified;
- "the non-negotiables in `CLAUDE.md` bind you", plus any constraint specific to its area;
- **tests first**, red before green; **checks narrowed to its files** (table above), never `bun run verify`;
- **no git writes**: reads only (`diff`/`show`/`status`/`log`); never `checkout`, `restore`, `stash`, `reset`, `add`, `commit`. Auditors too: read-only means no git writes;
- **no spawning**: a slice too big is reported back;
- **never "ask me"** — it cannot: decide and flag it, or stop and report with evidence. You take the question to the user.

## The flow

1. **Understand.** One line: the goal, which of the eight primitives, which tier. URLs in the ask → `WebFetch` the *mechanism*, then translate it onto this stack.
2. **Distrust the paperwork.** `docs/idea/` is intent; `docs/architecture/` and the roadmap may have moved. Merged commit subjects are the cheapest truth. Name what you falsified; fix the doc in the same PR.
3. **Prove it on the reference app.** `bun run x -- doctor --json --cwd examples/dummy`, `bun run x -- <cmd> --json --cwd examples/dummy`, the dev MCP (`mcp__ultimate-dev__*`, wired in `.mcp.json`, which `bun run setup` copies from the tracked `.mcp.json.example`). **Run the printed `fix:` before improvising.** A real trace outranks a reading.
4. **Explore** with read-only agents over disjoint areas (tier bands, `scripts/`, `examples/dummy/`, `wiki/`), within the worker cap. Require severity, `file:line`, one-sentence defect, concrete failure scenario — plus the doc claims they **falsified** and the premises that held.
5. **Live user reports are first-class**: observed outranks inferred. Reproduce, root-cause, rank them first; extend the owning agent's brief.
6. **Track in GitHub issues.** `gh issue list --search "<area>" --state all` before creating one; wire each PR with `Fixes #NNN`.
7. **Build.** Branch while the tree is clean: `git fetch origin && git status --short`, then `git checkout -b <feat|fix|refactor|docs|test>/<slug>`. Fix slice boundaries before launching anyone; two agents that must edit one file are one slice. A cross-package change lands **lowest tier first**, with its first real caller. Small feature → one agent.
8. **Verify.** `bun run verify`, once, in the background. Never narrow it, disable a rule or loosen a flag to pass. A public export moves its `README.md` + package `CLAUDE.md`; a code lands in `wiki/Error-Codes.md` (`bun run new-error-code`); a flag in `wiki/CLI-Reference.md`; a primitive usage in `examples/dummy/`. Touching client-reachable code, a budget or a tracked app: `bun run scripts/reference-app-gate.ts` and each touched app's `bun run x -- manifest --cwd <app>`.
9. **Commit & merge.** After every agent finishes. Sweep leftovers first: probes at the root, debug logging, stray `dist/`/`.tsbuildinfo`. `git add <this slice's paths>` (never `-A`), read `git status --short`, commit, push. **Main moves under you**: `git fetch`, intersect main's changed files with yours, three-way merge a real overlap (`git merge-file -p ours base theirs`) — never take one side wholesale. Merge with `gh pr merge --squash` once CI is green on the **head commit** and every review is addressed. `claudetm merge-pr <pr>` is an optional internal tool; one PR in flight. **0 registered checks reads as "pass"** — wait for a plausible count with nothing pending.
10. **Release + close.** Only when asked or for a confirmed security advisory; else `bun run scripts/release-due.ts --json` decides weekly. [`PUBLISHING.md`](../../PUBLISHING.md): `bun run scripts/release.ts --bump <major|minor|patch>` on a branch; the `chore: release X.Y.Z` PR merged on green CI **is** the release (`release-tag.yml` tags, dispatches `release.yml`; never tag by hand); wait for `gh run list --workflow release.yml --limit 1`; `bun run scripts/registry-audit.ts --json` must answer *N/N publishable packages on npm at X.Y.Z, every one attested* — quote it. Confirm each `Fixes #NNN` closed.

## Reach: credentials are reach, the ask is the authorisation

Inside the ask, a credential you hold is a step you take — probe reach at step 1. Outside it, a credential authorises nothing: `NPM_TOKEN` is not a request to publish. **An irreversible act needs the user's own words.** For a release that act is merging the release PR; `npm-publish` has no reviewers, so nothing is approved after.

```bash
ls -a | grep -i '^\.env'                                  # which env files exist
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' .env | sort -u         # key NAMES only — never cat .env
gh auth status                                             # scopes: repo, workflow, read:org
gh repo view --json nameWithOwner,viewerPermission         # can you push, can you merge
git remote -v | sed -E 's#//[^/@]+@#//***@#'               # never bare: a CI clone's URL holds a token
```

Say in one line what you can and cannot finish. Never print a value, token or OTP anywhere; pass secrets through the environment (`NPM_CONFIG_OTP="$(…)" cmd`).

| Reachable when… | You own, without asking |
|---|---|
| `gh` has `repo` | branch, push, PR, `gh pr merge --squash`, close issues |
| `gh` has `workflow` | `gh run rerun <id> --failed`; finish a half-cut release with the command `release-tag.yml`'s failed step printed |
| `.env` has `NPM_TOKEN` | `npm view`, `npm whoami`, `registry-audit.ts` |
| `.env` has `NPM_TOTP_SECRET`/`NPM_TOTP_URI` | a fresh OTP at call time (a small Bun HMAC-SHA1 snippet), never stored or echoed |
| nothing | `trust-publishers.ts --check` from a token answers `E401` — "0/30 trust" is a false negative. The signal: `npm view @ultimat3/core@<last> _npmUser dist.attestations` names `GitHub Actions` + a `trustedPublisher` |

Never `npm publish` from a laptop: provenance comes only from `release.yml`.

## Run mechanics

- **Commands that never prompt**: absolute paths, `git -C <repo>`, `bun run x -- <cmd> --cwd <app>`; a `cd` in a compound command can prompt and stall an unattended run.
- **Where run files go — the one rule.** Anything that must survive the run (worker rules, briefs, a pinned Bun, logs, PR bodies, probes): `node_modules/.cache/<run>/` — inside the checkout, git-ignored, never cleaned. Anything that must not see this repository's config (a scaffolded app, a `git archive` export): the session scratchpad, treated as disposable. Never a tracked path, never the repo root.
- **Toolchain parity**: a sweep that moves the Bun pin runs every gate on that release (checked against `SHASUMS256.txt`, on `PATH`).
- **Background jobs**: run the gate itself with `run_in_background`; `pkill -f <pattern>` kills its own shell. A PR waiter waits for the head commit's run before counting checks.
- **Which command gates what**: the root is `bun run verify [--only <steps>]`; one app is `bun run x -- verify --cwd <app>` — the app-shaped steps the root skips run there.
- **A budget overrun is attributed before it is raised**: compare whole-chunk bytes (`.x/build-stats.json`) against a `git archive origin/main` build; raise by the measured number (`bun run budget-raises`).
- **A live red is checked against the ports first**: a foreign service on a test port silently breaks the compose bind — `docker port <container>`.
- **Shared files move together**: `bun run new-error-code` is the coordinator's; a `BREAKING —` changelog line and its `wiki/Upgrading.md` entry land in one diff (`bun run changelog-check`).
- **Other repos are not this one**: there, work in a git worktree, never on the owner's checkout.
- **The hooks** (`.claude/settings.json`): `guard-destructive-git.sh` refuses discarding uncommitted work in a checkout of this repository; `guard-test-path.ts` refuses a `bun test` path without its leading `./`; `after-edit.ts` formats the edited file (+ `boundaries` for a package file); `stop-drift.ts` blocks one stop over a stale manifest or schema dump; `snapshot-tree.sh` commits the tree to `refs/snapshots/<epoch>` every 5 min when tracked files changed (never for a read-only agent). Restore: `git show --stat <ref>`, `git checkout <ref> -- <path>`; prune after merge: `.claude/hooks/snapshot-tree.sh --prune`. After any audit, re-check `git status` against the roster.
- **Fix, never pin, what a tightened guard surfaces**; a pin is for a site that cannot change, with its reason. **A flake is proved**: re-run alone 3×, said in the PR body.
- **CodeRabbit's stale verdict**: with CI green on the head commit and zero unresolved threads, dismiss that one stale `CHANGES_REQUESTED` with its reason (`gh api -X PUT repos/{owner}/{repo}/pulls/<n>/reviews/<id>/dismissals -f message='…' -f event=DISMISS`), then `gh pr merge --squash`. Never `--admin` without the user's words.

## Output

```
Primitive:   <which of the eight>   Tier: <n>   Packages: @ultimat3/<…>
Fixed:       <n> findings across <m> PRs → #… #…
Deferred:    <n> — <what, and why not now>               [never omit this line]
Falsified:   <docs/idea or roadmap claims that were wrong, now corrected>
Gate:        bun run verify ✓  (21 steps)  · reference-app-gate ✓ | n/a
Codes:       <new X_SCREAMING_SNAKE error codes, or none>   wiki updated: <y/n>
Dummy app:   <what examples/dummy/ now demonstrates, or unchanged>
Release:     <the registry-audit line verbatim | not released (merged only), because …>
Reach:       <what your credentials let you finish; what you could not and why>
Issues:      <#NNN closed, or none>
```

A sweep that fixes 40 of 90 findings is a success only if the other 50 are named.
