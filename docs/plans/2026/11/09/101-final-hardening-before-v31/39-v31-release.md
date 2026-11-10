# 39 — Cut v31: the final major

> Part of [`overview.md`](overview.md). Depends on: every framework slice (01–29). Coordinator-owned. Merging the bump PR is the release (memory: AI-maintained split).

## Steps
1. `wiki/Upgrading.md` — the 30 → 31 page complete: every `v31-break` from slices 07, 08, 12, 13, 15, 17, 20, 21, 29 with old → new and the exact edit. Order by how many apps it touches.
2. `CHANGELOG.md` — `## 31.0.0 - <date>` with **Highlights** (`X_CHANGELOG_HIGHLIGHTS_MISSING`): adapters with conformance suites, the instrumentation bus + semconv, big-data and scale fixes, security fixes, deletions. The stability line: next major no earlier than `<date + 90>`.
3. `bun run scripts/release.ts --bump 31.0.0` — writes manifest, `bun.lock` facts, footer stamp (memory: the three derived files); `bun run scripts/release.ts --check 31.0.0` green.
4. PR → CI green → merge → `release-tag.yml` makes an **annotated** tag; delete any bot lightweight-tag Release made before the bump (memory: bot auto-release squats tags).
5. Verify, polling for npm lag: `bun run scripts/registry-audit.ts --json` (all at 31.0.0, attested), `npm view @ultimat3/core@31.0.0 dist.attestations`, `gh release view v31.0.0`, `git ls-remote --tags origin 'refs/tags/v31.0.0*'`.
6. `wiki/Stability.md` — "v31 is the stable line"; the computed next-window date.
7. Then: adopters [`40`](40-adopter-a.md)–[`48`](48-adopter-i.md), infra [`26`](26-infra.md) F6/F7, trust [`27`](27-trust-docs.md) version line.

## Done when
- Every fact row in `CLAUDE.md`'s "Read it yourself" table answers 31.0.0.

## Outcome (2026-11-10)
Done. Three releases in one day, each on npm with all 31 packages attested by SLSA provenance and an annotated tag (`git ls-remote --tags origin 'refs/tags/v31*'`, `gh release list`).

| Release | PRs | Tag on |
|---|---|---|
| 31.0.0 | #1046 | main `f557b5e9d` |
| 31.1.0 | #1047 + #1048 | the bump PR's head `f45100336`, not main's `db03c9b69`. The tree is identical (`82f6b088f`). The bump branch was named `release/31.1.0`, and `release-tag.yml:36` accepts `release/*` CI runs ([#1054](https://github.com/developerz-ai/ultimate/issues/1054)) |
| 31.2.0 | #1049 + #1050 | main `97f6d102e` |

Field reports fixed after 31.0.0, from the upgrades in [`40`](40-adopter-a.md)–[`48`](48-adopter-i.md):

| Release | Fixed |
|---|---|
| 31.1.0 | exercise room attribution; the `x affected` base; `--paths` stdout; `x ci` fix lines; `x pr review` completeness; `X_WORKSPACE_EXTERNAL_DEP_UNDECLARED`; `x shot` GPU |
| 31.2.0 | `runtime.ts` ports in build and exercise; the storage boot; the sign-in cookie plus `oauthLogin({ callbackPath })`; `X_TYPESCRIPT_VERSION`; fetch-as-value; memory 23505; factory literals |
