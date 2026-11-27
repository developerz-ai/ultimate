# 10 — Breaks on `next` (major window 2027-02-08)

> Part of [`overview.md`](overview.md). Depends on: 04 (rows on `main`), 01 action 1 (`next` synced). Tier: 0–3. **PRs target `next`, never `main`** (`X_BREAKING_ON_MAIN`, `wiki/Stability.md:114`). Tracking: #1162.

Rule: the non-breaking half ships on `main` first (deprecation or warning;
`X_RELEASE_UNDEPRECATED_REMOVAL`); the break lands on `next`; at the window `scripts/release-due.ts`
proposes `next` → `main` as `chore: release X.0.0` and the coordinator merges it once `bun run verify` and CI are green on it.

## This plan's breaks (one worker, one PR to `next`)

| Break | Main half (04) | On `next` |
|---|---|---|
| #1280 unsigned live cursor | optional `sig`, counted hook | anything but a matching `sig` ⇒ cold start, new `ResumeReason` |
| #1281 unknown input keys | `X_INPUT_UNKNOWN_KEY` warn | `unknownKeys()` non-empty ⇒ `X_INPUT_INVALID` with nearest key in the fix line. Audit framework-reserved query-string keys that reach the parse first. Do **not** take `origin/dz/publish-accurate-unknown-key-semantics--7e8b83d9` (flips the schema to `additionalProperties: true` — the wrong direction). |
| device hello without `v` | `v` optional, absent = 1 | refused with `X_DEVICE_WIRE_VERSION` |
| new guards (`motion-adapter`, `raw-frame-loop`, `effect-without-fallback`) and `x kit` drift without `kit.json` | warnings (06, 07, 09) | errors |

## The 20 already parked (`scripts/lib/next-breaks-list.ts`)

Group into four PRs to `next` (from the #1162 triage), slotting the 9 newer rows:

| Group | Rows |
|---|---|
| g1 entity/db/query | E12/E2, E9, E1, Q2, `tenantColumn`, `orgIdOf`, A7 db |
| g2 cli | X8/G1, G6, `X_BOUNDARY_DEV_IMPORT`, A7 admin |
| g3 jobs/realtime | J18, `onSettled`, A7 realtime |
| g4 core/auth/pwa/docs | K4, `ERROR_DOCS_URL`, T3, error-reference pages, legacy OAuth cookie, PWA never-wired fields |

Each: drop its row and regenerate #1162's body (`bun run scripts/next-breaks.ts`).

## Done when

- `next` holds every break, `git log main..origin/next` lists them, `bun run verify` green on `next`.
- At 2027-02-08: release PR merged by the coordinator; #1162 closed.
