# `/feature`: why each rule exists

Narrative cut from `.claude/commands/feature.md` on 2026-11-13 (plan 101 sweep 19b, Y4), when the
command had reached 38 KB, most of it restating `CLAUDE.md`, and every invocation read it whole.
The command keeps the rules and is held at 16 KB by `scripts/claude-md-size.ts`
(`X_CLAUDE_MD_OVERSIZE`); this page keeps the incidents. Nothing here is a current fact.

| Rule in `/feature` | What happened |
|---|---|
| one PR at a time, never a stack | 2026-10-01, plan 101: ~1,450 files across 13 stacked PRs. Each chunk failed CI alone (a lower tier's change landed before its consumers); CodeRabbit reviews only PRs based on `main`, so it skipped 12 of 13 until triggered by hand; the real verdict came only from the top of the stack, and every review fix had to be merged up through every branch above it |
| ~100 files per PR by default | CodeRabbit refuses above 150 changed files, so the biggest, riskiest PR gets the least automated review; a human cannot hold 279 files either, so approval becomes a formality. One red job holds every unrelated fix hostage, and bisecting lands on one enormous commit. Plan 101's final run (2026-11) widened it by owner ruling: 12 agents, 300–400 files |
| never git worktrees | each worktree needs its own `bun install`, its own `tsc -b` build graph and its own manifest, and hides half-finished work from the gate |
| only the coordinator spawns | nested fan-out turned a 4-agent sweep into 17: the live count stopped being knowable and two grandchildren edited one file |
| read-only means no git writes | a read-only auditor reverted a worker's entire file set (`git checkout`/`restore` of exactly the paths it was told to review) seventeen seconds into a gate run; the gate then measured a tree missing a whole slice. On 2026-11-07 one `git checkout -- .` lost ~200 files. Hence `guard-destructive-git.sh` and `snapshot-tree.sh` |
| audit a high-stakes diff before opening | a `security-auditor`/`concurrency-auditor` pass found a pre-existing High open redirect and two High regressions in the sweep's own first-draft fixes (a drain that cut streamed bodies; a drain that re-sent in-flight webhooks) |
| `bun test ./…`, never a bare path | a bare `packages/mcp` is a substring filter that also ran `examples/dummy/packages/mcp` under the wrong config: 86 files and 13 false fails, against 75 and 0 with `./`. Since 2026-11-13 `guard-test-path.ts` refuses it |
| no `test:affected` in a hive | the dirty tree holds every agent's uncommitted work, so the affected set became everyone's and each run expanded to nearly the whole monorepo |
| run files in `node_modules/.cache/<run>/` | the session scratchpad was wiped several times mid-run (plan 2026/10/04), taking a pinned toolchain and the agents' shared brief with it |
| `--workers` on a shared machine | the default width took the whole gate down: OOM-killed twice on 2026-09-07 beside two other suites |
| wait on the gate, not a pattern | `pkill -f <pattern>` matched its own shell and killed it (exit 144); `setsid` returned at once, so the "done" notice arrived with nothing run. A PR waiter that counted checks right after a push read the previous commit's green |
| never `npm publish` from a laptop | that is how 2.0.0 lost its attestations ([`publishing-and-provenance.md`](publishing-and-provenance.md)) |
| `trust-publishers.ts --check` is a false negative from a token | measured 2026-08-22: `npx npm@12 trust list <pkg>` answers `E401 … You must be logged in to publish packages` even with a valid `_authToken` and a fresh OTP, because npm restricts 2FA-bypass tokens for account-level reads |
| never bare `git remote -v` | a remote cloned by `gh` or by CI is `https://x-access-token:<token>@github.com/…`, so the unredacted form prints a live credential into the transcript |
| a toolchain pin is re-downloaded | a sweep that moved the pin past the system Bun (1.4.0 → 1.4.2) measured a gate on the wrong runtime |
| a live red is checked against the ports | another `nats-server` on :4222 (or `redis` on :6379) made the compose container fail to bind, silently, and the suite talked to the wrong server |
| the stale CodeRabbit review is dismissed, never `--admin` | its `CHANGES_REQUESTED` survives every fixed and resolved thread; `--admin` bypasses every unmet requirement, not just that one |
