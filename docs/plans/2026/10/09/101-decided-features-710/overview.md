# Decided features from #648 (#710)

## Goal
Build the four rows of [#710](https://github.com/developerz-ai/ultimate/issues/710) still open —
owner decisions 5, 9, 10 and 19 (rest) of
[`00-owner-decisions.md`](../../04/101-squeaky-clean-sweep/00-owner-decisions.md) — and ship them
as one minor. Row 11 (Web Push) shipped in 26.1.0 (#716) and is not replanned.

## Context
- Bun only, no new dependency, no new primitive: every row extends one of the eight or a tracked app.
- Rows are independent: one PR each, merged in this order, then one `scripts/release.ts --bump minor`.

## Tiers touched
| Package | Tier | Why |
|---|---|---|
| `core` | 0 | the query wire carries which values were instants (row 19) |
| `auth` | 2 | `login()` keyed by a handle, additive (row 9) |
| `jobs` | 3 | `redisJobDriver()` (row 5) |
| `query` | 3 | the read projection names its instants (row 19) |
| `ui` | 4 | `uiStrings()` + `UiProvider strings=` (row 19) |
| `cli` | 5 | the sibling-layout refusal; generator docs (row 10) |
| `testing` | 5 | the Redis conformance run (row 5) |

## Sweeps
| Sweep | Slice | Est. files | Tier band |
|---|---|---|---|
| 1 | [`01-redis-job-driver.md`](01-redis-job-driver.md) | 15 | 3–5 |
| 2 | [`02-reference-app-workarounds.md`](02-reference-app-workarounds.md) | 25 | 0–4 + reference app |
| 3 | [`03-one-generator-layout.md`](03-one-generator-layout.md) | ≤ 100 | 5 + both apps |
| 4 | [`04-demo-adopts-auth.md`](04-demo-adopts-auth.md) | 30 | 2 + demo app |

## Done when
- Each slice's *Done when*; `bun run verify` and `scripts/reference-app-gate.ts` green on each PR.
- One minor on npm, attested; #710 closed with a row → PR/version map.

## Risks
- Row 10 moves many app files: the app gate's ratchet (`scripts/lib/gated-apps.ts`) must not regress.
- Row 9 changes where the deployed demo keeps credentials: the demo's `credentials`/`sessions`
  rows are carried into `x_users`/`x_sessions` by a migration, or the seeded logins are re-bootstrapped.
