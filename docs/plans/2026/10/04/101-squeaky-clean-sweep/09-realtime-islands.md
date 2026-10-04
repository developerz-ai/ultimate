# 09 — Realtime: write echo, offline first paint, shared island runtime

> Part of [`overview.md`](overview.md). Depends on: 08 merged; owner O-506, O-507 for the starred parts. Tier: 3 + 5. **Sweep 9.**
> Order inside the sweep: #507 part 1 → #505 cut 1 → #506 (hold point lives in the shared boot).

## Agents (≤ 4, disjoint)
| Agent | Issue | Exclusive paths |
|---|---|---|
| A — wire write echo | #507 pt 1 | `packages/realtime/src/{live-fanout,sync-frames,client-frames,live-rows,live-resume,changefeed}.ts` + tests |
| B — shared runtime | #505 cut 1 | `packages/realtime/src/{boot,page-store,page-socket}.ts`, `use-*.ts` hooks, `packages/cli/src/island-realtime.ts`, both apps' `app.config.ts` budgets |
| C — offline first paint | #506 | after B: `packages/render/src` hydration gate, `examples/dummy/apps/web/e2e/offline-like.e2e.test.ts` |
| D — e2e proof | all | `examples/dummy/apps/web/e2e/one-record-many-places.e2e.test.ts`, `packages/realtime/src/boot.test.ts` |

## Issues → fix

| Issue | Root cause | Fix | Test |
|---|---|---|---|
| **#507** patch frames name no write | `live-fanout.ts:134-140` builds patch without `write` though `ChangeEvent.write` exists (`changefeed.ts:41`); `client-frames.ts:83-97` → `live-rows.ts:88-101` merges without settling; only `records` frames settle (`client-channels.ts:249-253`) | Pt 1: `write` on patch frame + wire parse (`sync-frames.ts:195`, validate like `wire-channel.ts:31`); `client-frames.ts:96` `store.settleWrite(frame.write, carried)` in the same batch. Make `ChangeEvent.write: string \| null` **required** (type is the enforcement). Resume (`live-resume.ts:72`) carries `writes[]`. ★ Pt 2 (HTTP catch-up names its writes, e.g. a response header) — design per O-507 | `live-fanout.test.ts`, `client-frames.test.ts`; e2e: a live list never shows truth + overlay |
| **#505** each island bundles the realtime runtime | Default path = one build per island, splitting off (`cli/src/island-bundle.ts:380-382`); `islands.sharedChunks` opt-in only | Cut 1: `realtime/src/boot.ts` owns store, socket, host, channel book, outbox on `Symbol.for('ultimate.realtime')` (`page-store.ts:39`); hooks become thin readers; `island-realtime.ts` stops inlining. Lower both apps' budgets by the **measured** amount (axiom 9) | `cli/src/island-realtime.test.ts` island chunk excludes the store; budgets lowered with numbers in the diff |
| **#506** offline reload paints stale count first | Overlays restored after async IndexedDB read (`realtime/src/boot.ts:30-48`); islands paint server/SW HTML first (dummy `personalPages: 'last-member'`, `examples/dummy/app.config.ts:62`) | ★ O-506 default (option 3): islands with a live hook hold first paint until `pageRealtime().booted`, capped by a timeout | Extend `offline-like.e2e.test.ts:114-115` to assert the reload paint; `boot.test.ts` unit |

## Steps
1. Branch `feat/sweep-9-realtime`. A and B in parallel; C after B reports; D last.
2. `bun run verify` with live services; app gate (`bun run scripts/reference-app-gate.ts`).
3. Pre-PR: `concurrency-auditor` over the diff (realtime = high-stakes surface). PR `Fixes #505 #506 #507` (or `Refs #507` if pt 2 waits on O-507).

## Done when
- Realtime islands on `/posts/:id` shrink by the measured amount (issue estimate ~50 kB), number in the PR.
- e2e: no truth+overlay flash; offline reload shows the queued value on first paint.
