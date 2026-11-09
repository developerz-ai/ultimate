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
