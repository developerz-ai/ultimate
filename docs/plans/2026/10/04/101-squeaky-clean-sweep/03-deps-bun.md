# 03 — Dependencies: Bun 1.4.2, toolchain bumps, retire the 1.4.0 workarounds

> Part of [`overview.md`](overview.md). Depends on: 02 merged. Tier: tooling + 0/4/5 tests. **Sweep 3.**
> No new dependency. Versions As of 2026-10-04 (`bun outdated -r`, npm `bun` dist-tag).

## Rule
A pin names the patch somebody measured (`.github/actions/setup/action.yml:85-100`). Moving it = run
the gate on the candidate and write the numbers beside the pin, same diff.
`scripts/bun-pin.test.ts` moves every Bun pin together — it is the enforcement.

## Inventory

| Dep | Now | Target | Where |
|---|---|---|---|
| Bun runtime | 1.4.0 | 1.4.2 | `.github/actions/setup/action.yml:101`, `.github/workflows/release.yml:213`, `packages/cli/src/app-root.ts:37` (`REQUIRED_BUN`), `scripts/setup.ts:31`, 42 × `engines.bun` (`grep -rln '"bun": ">=1.4' --include=package.json`), `docker/Dockerfile:46,56,63` (`oven/bun:1.4-slim@sha256:…` — re-pin digest), `packages/cli/src/templates/scaffold-container.ts:35,42` (`oven/bun:1.4-alpine@sha256:…`) |
| `@types/bun` | 1.4.1 | 1.4.2 | root + `dummy/social-media-clone/package.json` |
| `@biomejs/biome` | 2.5.8 | 2.5.15 | root + `dummy/social-media-clone`; scaffold template's pinned biome version (`grep -rn biomejs packages/cli/src/templates`) |
| `lefthook` | 2.1.10 | 2.1.16 | root |
| `sass` | 1.104.0 | 1.105.1 | `packages/render/package.json` |
| GitHub Actions (SHA-pinned) | 10 actions | latest release SHA each | `.github/workflows/*.yml`, `.github/actions/setup/action.yml` — keep SHA pins + version comment |
| Service images | `postgres:17-alpine`, `pgvector/pgvector:pg17`, `redis:7-alpine`, `nats:2.11-alpine`, `versity/versitygw:v1.8.0` | latest patch of the same major | `docker/docker-compose.{dev,test}.yml`; digest-pin per plan 2026/10/02 slice 13b |

## Agents (≤ 4, disjoint)
| Agent | Exclusive paths |
|---|---|
| A — Bun pin + measurement | every Bun pin above, `scripts/bun-pin.test.ts`, `bun.lock` (coordinator runs `bun install` once) |
| B — #276 workaround removal (after A's pin is in the tree) | `scripts/browser-barrel.test.ts`, `packages/core/src/{async-context,logger,logger-browser}.test.ts`, `packages/ui/CLAUDE.md:19`, `docs/history/ui.md:16` |
| C — #354 predicate removal | `examples/dummy/apps/web/island-bytes.test.ts`, `packages/ui/src/barrel-bytes.test.ts`, `packages/cli/src/island-identity.ts:27`, `scripts/lib/side-effects-scan.ts:69-91` (comments only) |
| D — toolchain + actions + images | `package.json` devDeps, `packages/render/package.json`, `.github/workflows/*.yml` `uses:` lines, `docker/docker-compose.*.yml` images, biome-induced lint fixes (`bun run lint:fix`, coordinator commits) |

## Steps
1. A: bump every Bun pin to `1.4.2`; run `bun run verify` + `bun run scripts/reference-app-gate.ts` on 1.4.2; record in `action.yml` above the pin: barrel bytes (`barrel-bytes.test.ts`), dummy like-island bytes, CI wall time. If `barrel-bytes` pins fail, **raise by the measured amount** with `bun run budget-raises` (`X_BUDGET_RAISE_UNSTATED`) — never stub. Close the `As of 2026-09-05` paragraph as history.
2. B (#276, oven-sh/bun#40578 fixed in 1.4.1): delete the negative control (`browser-barrel.test.ts:245-270`), build `packages/<name>/src/index.ts` directly in `barrelChunk` (`:134-170`), simplify the three core test notes, reword the history mentions.
3. C (#354, oven-sh/bun#40650 + #40657 fixed in 1.4.1): delete `sameUpToRenaming`/`renamedOnly` (`island-bytes.test.ts:255-320`), require `after.url === before.url`, delete the shaker-flap branch; re-measure ≥ 60 child-process build pairs under contention and record the numbers in the test header. Keep #399 anchors unless measured redundant.
4. D: bump devDeps; `bun run lint:fix` for biome 2.5.15 rule changes (if > 60 files change, split biome into its own follow-up PR to stay ≤ 100 files); actions to latest SHAs; service images to latest patch + digest.
5. #355 (oven-sh/bun#40579 still open): add the upstream URL to the "Revisit if Bun wires either" comment at `packages/render/src/module-loader.ts:44-45`; close #355 as tracked upstream (owner O-355).
6. Optional: tighten the scaffold dashboard budget (`packages/cli/src/templates/scaffold-dashboard-shared.ts:20-26`) to the 1.4.2 measurement + margin (#490 follow-up) — measured, with the `budget-raises` line.
7. `bun run lockfile` clean; `bun run verify`; app gate; PR `Sweep 3 — Bun 1.4.2 + deps` with `Fixes #276`, `Fixes #354`.

## Tests
- `scripts/bun-pin.test.ts` green (all pins agree).
- `scripts/browser-barrel.test.ts`, `island-bytes.test.ts`, `barrel-bytes.test.ts` tightened — 10/10 local runs green, CI green.

## Done when
- `bun --version` in CI = 1.4.2; every pin agrees; measurements written beside the pin.
- `bun outdated -r` shows nothing behind for the five deps above.
- #276, #354 closed by the merged PR; #355 closed with upstream link.
