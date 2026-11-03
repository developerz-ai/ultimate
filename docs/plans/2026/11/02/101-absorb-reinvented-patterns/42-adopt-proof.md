# 42 — Adoption: comparison pages, migration guides, benchmarks anyone can re-run

> Part of [`overview.md`](overview.md). Depends on: [`42-adopt-first-hour`](42-adopt-first-hour.md); [`30-perf-gate`](30-perf-gate.md) stays the regression gate, this is the published figure. Tier: `scripts/`, docs, CI.

## Why
A stranger's next question after "what is it" is "against what I use now?". Today:

| Asked | Found 2026-11-02 |
|---|---|
| comparison | `wiki/FAQ.md:161-168`: five one-line rows, none stating a loss |
| migration | `wiki/Migrating-An-Existing-App.md`: a good generic runbook, `As of 2026-08`, four source stacks lumped; no concept map for any of them |
| speed, size | only the realtime restart bench (`scripts/bench/restart-bench.ts`, needs this repo). No install, cold start, request or memory figure; `README.md:152-169` has none to cite |
| reproducible | restart bench: yes, in-repo. A stranger's own app: no harness |

Measured baseline to publish, one box, 2026-11-02: first run 37 s, `node_modules` 192 MB, 299 tarballs, 204 scaffold files, image 286 MB, `/` 3,955 B at 0 JS, `/dashboard` 35,173 B JS, gate on first feature 37 s. Nothing here is on a public page.

## Decisions
| Question | Answer |
|---|---|
| Head-to-head charts | none from us. Comparator apps would pull another stack's lockfile into this repo (no new dependency), and a vendor's own numbers against rivals convince nobody. We ship the harness and our figures; anyone can point it at theirs |
| Comparison tone | each stack gets "pick it instead when", first. A page without a stated loss fails review. Every favourable row cites a command, a file or a Known-Gaps row |
| Which stacks | the five rows at `wiki/FAQ.md:163-168` and the four source stacks at `wiki/Migrating-An-Existing-App.md:5`. Executor names them on those pages, as they do today; a plan file does not |
| One page or many | `wiki/Compared.md`, one page. Migration: one page per source stack, since each carries a concept map |
| Unexecuted migration guides | stated in line one: `not executed end to end`. Flip on evidence from an adopter's run, unnamed |
| Bench host | free `ubuntu-latest`, weekly plus on release. Variance is reported, min and median of 5, and runner type is printed |
| Bench target | the **published** tarball: a stranger's path, never a workspace link |
| Throughput claim | scaffold `/` and a typed action through the full pipeline on embedded and on real Postgres; scoped per run like `scripts/bench/results/README.md` |

## Files to change
- `wiki/Compared.md` (new), `wiki/FAQ.md:161-168` — the FAQ row table becomes a link.
- `wiki/Migrating-From-*.md` (new, one per source stack), `wiki/Migrating-An-Existing-App.md` — concept map: their routing, ORM, background jobs, auth and realtime terms mapped to a primitive; what does not map; schema adoption specifics; identity cutover.
- `wiki/_Sidebar.md`, `wiki/Home.md`.
- `scripts/bench/first-hour.ts` (new) + test — scaffold, setup, first page, first feature, gate, image, with times and sizes.
- `scripts/bench/http-hello.ts` (new) + test — requests per second, p50, p99, RSS, cold start. A plain fetch client on Bun; no load-tool dependency. `--url` lets it target any app, any stack.
- `scripts/bench/results/first-hour.json`, `http-hello.json`, `scripts/bench/results/README.md`.
- `scripts/bench-claims.ts` — holds the new figures; reuse `X_BENCH_CLAIM_STALE`.
- `.github/workflows/bench.yml` (new) — weekly + release, opens a PR with new JSON. No new secret.
- `README.md` — proof table; coordinate with [`42-adopt-front-door`](42-adopt-front-door.md), which owns the structure.

## Steps
1. `first-hour.ts`: clean `HOME` and `BUN_INSTALL`, `bunx create-ultimate`, then the table in 42-first-hour. JSON plus a log, like `scripts/bench/results/`.
2. `http-hello.ts`: `--url`, `--concurrency`, `--seconds`. Refuses a run shorter than 10 s. Prints box facts.
3. Commit first results; `bench-claims.ts` ties README and `wiki/Compared.md` figures to the JSON.
4. `wiki/Compared.md`: per stack a table: pick that when; pick this when; what you give up here (Bun-only, Postgres-only, one renderer, young, one major per window, no third-party audit: `SECURITY.md`). Sourced from `.dz/maintainer/maintainer.yml:48-54` and `wiki/Known-Gaps.md`.
5. Concept maps: one table per guide, every right-hand cell a wiki link or an `x` command. `doc-paths` and existing link guards apply.
6. One migration guide executed end to end by a scratch app of that stack, or an adopter's measured cutover, before the guide says `executed`.
7. "Reproduce this" block on `wiki/Compared.md`: two commands that need only Bun and a clone.

## Error codes
`bun run new-error-code`, `--off-socket`. Existing: `X_BENCH_CLAIM_STALE`.

| Code | When | Fix |
|---|---|---|
| `X_BENCH_RUN_TOO_SHORT` | `http-hello` under 10 s | `bun run scripts/bench/http-hello.ts --url <url> --seconds 30` |

## Tests
- `first-hour.test.ts` with a fake runner: step order, JSON shape, a failed step recorded as failed, never as a zero time.
- `http-hello.test.ts` against a local server: non-2xx responses counted and reported, a server dying mid-run is not a pass.
- `scripts/bench-claims` test: a README number off by one fails.
- `bun test scripts/bench/http-hello.test.ts`

## Semver
No package change.

## Done when
- `bun run scripts/bench/first-hour.ts` and `http-hello.ts --url` run on a clean clone, and the committed JSON came from CI.
- Every figure on `wiki/Compared.md` and in the README proof table fails `bench-claims` when changed.
- Each `wiki/Compared.md` section has a "pick it instead" row; each migration guide states `executed` or `not executed` in line one.
