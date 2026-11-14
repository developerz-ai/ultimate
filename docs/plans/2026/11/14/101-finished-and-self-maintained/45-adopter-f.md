# 45 — Adopter F

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md) released. **Another repository**: edited from its own checkout, in a git worktree when that checkout is dirty or off its default branch. One PR, ≤ 100 files, more PRs if larger. Never named in this tree.

## Shape
Offline-first point-of-sale on a LAN tablet. As of 2026-11-14: framework 31.22.0, default-branch CI green. Gate steps it never runs: live, job, e2e, roadmap.

## Files to change
| Item | Where | Replacement |
|---|---|---|
| TLS terminator for a secure origin on a LAN | `bin/serve-https.ts:3-8` | `x dev --host --tls` ([`07`](07-gate-truth.md) G5) |
| IPv6 loopback relay | `bin/loopback6.ts:4-9` | same |
| offline-first without the `pwa` package | whole app | adopt `pwa`; the `offline` shape is the reference ([`13`](13-shapes-and-declaration.md)) |
| own PIN + signed-cookie auth | `apps/web/app/auth/authenticator.ts:1-8`, `packages/pin` | stays app code; align with the recipe ([`04`](04-auth-http.md) step 4) |
| `'ssr'` downgrade | `apps/web/app/pos/page.tsx:23` | `<Hole>` |

## Steps
1. `x upgrade` to the latest release. Any hand edit it needs is a defect against [`08`](08-upgrade-without-hands.md): file it, do not absorb it.
2. `x.verify.json` → `strict: true`; every step runs or carries a written `why` ([`07`](07-gate-truth.md) G1). `roadmap` may carry a `why`; `live` and `e2e` may not where the app has a database or a page.
3. Delete each workaround in the table for its framework replacement; `x doctor` reports zero superseded workarounds.
4. Turn on the automated framework upgrade ([`31`](31-maintainer-platform.md) P2): stop excluding `@ultimat3/*` from dependency automation.
5. Report back what the framework still lacked. A gap seen here joins [`20`](20-audit-rounds.md)'s next round as evidence.

## Tests
- The app's own gate: `bun x x verify` green with `strict: true`, on its CI.

## Done when
- On the latest release by an `x upgrade`-only PR; strict gate green; the table above empty or each remaining row justified in the PR.
