# 40-next-fault-drills — `x drill`: real roles, real services, every failure this plan found

> Part of [`overview.md`](overview.md). Depends on: [`29-data-pg-unanswered.md`](29-data-pg-unanswered.md), [`29-data-redis-outage.md`](29-data-redis-outage.md), [`33-ops-worker-roll.md`](33-ops-worker-roll.md), [`03-core-lifetime-helpers.md`](03-core-lifetime-helpers.md). Tier: 5 (`testing`, `cli`).

## Why
This plan's outage findings came from throwaway probes: a TCP proxy that blackholes the pool's sockets while the server stays healthy (`29-data-pg-unanswered.md:11`), a dead Redis that blocks, a worker roll that cuts a job. Each slice fixes one. Nothing stops the next regression, and no app can ask "what happens to mine".
`deploy-proof` proves a clean rolling restart (`docker/deploy-proof/run.sh`, `.github/workflows/ci.yml:815`); `worker-soak` covers one driver in one process. Nothing runs a whole app through its dependencies failing.
Hard to match: the verdict is not "it survived". It is the framework's declared behaviour: `/readyz` flips, deadline from `requestTimeoutMs`, coded errors, jobs terminal, recovery with no restart. A framework that declares none of these can only measure a chart a person must read.

## Decisions
| Question | Answer |
|---|---|
| Name | `x drill`, because a drill states its expected result and fails on any other. Not random: axiom 5 needs a repeatable answer |
| Random fault mode | no. The seeded half is `40-next-job-crash-proof`, in process |
| Fault tool | a Bun TCP proxy, `Bun.listen` and `Bun.connect`, as `testing/src/sealed-network.ts` already listens. No dependency, no container, no kernel rules |
| Modes | `pass`, `delay(ms)`, `blackhole` (accept, never answer), `reset`, `refuse`; switchable mid-run |
| Topology | `web` and `worker` as separate processes (`ROLE`, `cli/src/serve.ts`), each dialing through a proxy per service |
| Load | lanes over routes and the exercise pass's reachable reads, as `docker/deploy-proof/load.ts`; POSTs carry idempotency keys |
| In `x verify`? | no. It needs Postgres, Redis and NATS. `x verify` stays dependency-free (axiom 5, `docs/idea/21-the-range.md:28`). It is a required CI job of this repository, on a scaffold, on `main` like `deploy-proof` |
| Missing service | refused, never a skip: a green drill that ran nothing is the vacuous pass `31-test-false-green` removes |
| Thresholds | derived from the app's config, not typed per drill. An override is `--budget-ms` and is printed in the verdict |
| Rung | one node per role. No multi-node NATS claim; `docs/idea/17-scale-ladder.md` stands |
| Business rules | none. Drills assert framework contracts, never an app's data |

## Drills
| Name | Fault | Must hold |
|---|---|---|
| `pg-blackhole` | live sockets unanswered, server healthy | requests end by deadline with a coded 5xx, pool replaces sockets, recovery with no restart, no statement applied twice |
| `pg-slow` | `delay` over the statement ceiling | coded timeout; no pool exhaustion after |
| `pg-restart` | `reset` then `refuse`, then `pass` | `/readyz` 503 inside its interval, back to 200; outbox rows relayed once |
| `redis-down` | `blackhole` on the cache tier | reads go to origin with one bounded delay, no blocked request |
| `nats-down` | `refuse` on the transport | `sync` clients reconnect; live queries resync, no sequence gap reported |
| `worker-sigkill` | `SIGKILL` mid-step | run reclaimed after the lease, finished steps replayed, terminal, no double effect |
| `worker-sigterm` | `SIGTERM` during a held job | drains or hands back within budget |
| `web-sigterm` | `SIGTERM` under load | zero non-2xx from a request accepted before the signal |

## Files to change
- `packages/testing/src/fault-proxy.ts` (new) — `faultProxy({ target }) → { port, set(mode), counts, close }`.
- `packages/testing/src/drill-fleet.ts`, `drill-load.ts`, `drill-verdict.ts`, `drills.ts` (new) — roles, load, verdict, table.
- `packages/testing/src/index.ts`.
- `packages/cli/src/cmd-drill.ts`, `cmd-drill-spec.ts` (new), `registry.ts`.
- `.github/workflows/ci.yml:815` — job `fault-drills`, beside `deploy-proof`; free runners; the job's question as its comment; `docs/history/ci-split.md`.
- `examples/dummy/README.md`; `examples/dummy/apps/web/e2e/drill.e2e.test.ts` (new) — `redis-down` only, when services are set.
- `wiki/CLI-Reference.md`, `wiki/Error-Codes.md`, `wiki/Known-Gaps.md`, `docs/ops/README.md` (a runbook pointer), `docs/idea/10-testing.md`, `packages/testing/{README,CLAUDE}.md`, `packages/cli/{README,CLAUDE}.md`.

## Steps
1. `fault-proxy` with unit tests over a local echo server, each mode. Mid-stream switch: bytes in flight are held, not dropped, in `blackhole`.
2. Fleet: each role's database, Redis and NATS URLs point at a proxy in front of `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_NATS_URL` (`docker/test-services.env:7`).
3. Verdict over evidence only: `{ requests: { ok, failedByCode, maxMs }, readyz, jobs: { stuck, doubled }, recoveryMs }`. An uncoded 5xx is always red.
4. `x drill [<name>] [--json]`. `--list`.
5. Run all on a scaffold. A slice not yet landed leaves its drill red: land this after the depended slices. Any new red is a bug in that PR, not a pin.

## Error codes
`bun run new-error-code <CODE> --package cli …` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_DRILL_FAILED` (new) | a stated property did not hold; the property and evidence printed | `x drill <name> --json`, then the printed code's `x errors explain` |
| `X_DRILL_SERVICE_MISSING` (new) | a drill's service is not configured | `docker compose -f docker/docker-compose.test.yml up -d --wait`, then `set -a; . docker/test-services.env; set +a` |

## Tests
- `testing/src/fault-proxy.test.ts` (unit): each mode against a local server; `set` mid-stream.
- `testing/src/drill-verdict.test.ts` (unit): each property fails on evidence that violates it.
- Each drill's negative control, `cli/src/cmd-drill.live.test.ts`: `redis-down` with the bounded wait from 29-redis removed from a fixture fails `X_DRILL_FAILED`.
- `bun test packages/testing/src/fault-proxy.test.ts`; `bun run x -- drill redis-down --cwd <scaffold> --json`.

## Semver
Minor. New command, new exports, no change to `x verify`. The CI job is this repository's own.

## Done when
- All eight green on a scaffold in CI within its job time-box; a reverted fix from 29-unanswered turns `pg-blackhole` red.
- An app with services up gets the same verdict from `x drill`.
- `wiki/Known-Gaps.md` states what the drills do not cover: multi-node, real S3, real CDN.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
