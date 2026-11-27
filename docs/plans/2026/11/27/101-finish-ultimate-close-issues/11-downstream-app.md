# 11 — Downstream app: adopt what shipped, delete workarounds

> Part of [`overview.md`](overview.md). Depends on: 01 action 5 (release out), then 03–05 releases for the rest. **Cross-repo: executed in the downstream app's own repository, in a git worktree there (it may be on the owner's branch) — never from this checkout.** Tier: n/a (app).

Context: the largest app built on Ultimate is pinned to 31.50.0. Its framework-fix plan is 16 of 17
slices landed upstream; its other plans carry stale "waits on the framework" notes. Every row below
was verified against this repo's `main` at `5a998a869`.

## Adopt — shipped upstream, app still works around it

| Framework capability | Shipped in | App action |
|---|---|---|
| `signInWithLink` (second factor after a mailed link) | 31.51.0 (#1353) | bump pin; start its two-factor slice; declare the sign-in purpose `signIn: true` (else `X_CONFIG_INVALID`, `packages/auth/src/link-login.ts:80-86`) |
| passkey label / `renamePasskey` | 31.50.0 (#1336) | drop the "waits for a passkey label" status note |
| second browser profile in e2e (`packages/testing/src/cdp-e2e-context.ts:19`) | 31.50.0 (#1341) | write the two-browser test; drop the note |
| `EmptyState`/`Alert` title as heading (`level`) | 31.50.0 (#1347) | remove the "reported upstream" comment in its states test |
| row-security policy as `case` (`packages/db/src/row-security.ts:26-38`) | 31.50.0 (#1342) | re-measure its hot-path rows and close them |
| row selection (`packages/ui/src/components/row-selection.ts`, `BulkBar`) | 31.50.0 | delete its own selectable tile + selection store |
| device socket `onOpen`/`onClose` (`packages/realtime/src/device-host.ts:68,193`) | 31.50.0 | replace its status sweep |
| `outbound({ refusal: { headers } })` (#1367) | next release (01) | delete the interim payment-vendor fetch hook |
| split i18n catalogs (#1375) | next release (01) | optional; flat catalogs unchanged |

## Adopt — after this plan's sweeps release

| Capability | Slice | App action |
|---|---|---|
| `service.name` from app config (#1361) | 02 | drop any manual `OTEL_SERVICE_NAME` workaround |
| plan judge exported from `@ultimat3/testing` | 05 | delete its `packages/db/src/testing/plan-judge.ts` + `plan.ts`; keep its ceilings as app numbers |
| mail recipient distinct from store key | 03 | delete its `runtimeOf` workaround in its identity service-link module |
| default egress proxy for framework senders | 03 | remove per-call proxy plumbing |
| verbatim MCP text (only if its escaping measurement > 15%) | 05 | switch the gateway result path |
| motion, effects, design research, agent kit | 06–09 | `x upgrade`; run `x kit`; adopt `Presence`/effects on its dashboard |

## Steps

1. Worktree in the app repo; bump every `@ultimat3/*` to the release from 01 (`bun run lockfile:fix` equivalent there), run its gate.
2. Delete each workaround above with its test; update the stale `status.yml` notes in its plans (framework-fix plan → complete; phase-0/phase-1 notes).
3. Repeat after each later release.

## Done when

- App pinned to the latest release, its gate green, no comment or status note claims a framework gap that `main` has closed.
