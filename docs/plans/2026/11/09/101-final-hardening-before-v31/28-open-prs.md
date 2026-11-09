# 28 — Open PRs: land or close before sweep 1

> Part of [`overview.md`](overview.md). Depends on: none. Tier: mixed. Sweep 0. Coordinator-owned (git, reviews); one worker for #1033's code.

## State, as of 2026-11-09
| PR | Checks | What it needs |
|---|---|---|
| #1028 distroless digest | green | bot review is CHANGES_REQUESTED with 0 findings (its injection screen withheld the title). Comment `@developerz-ai review` or dismiss the stale review with a reason, then squash-merge. Never `--admin` for a stale bot review |
| #1029 s3-gateway versitygw 1.10.0 | green | same as #1028. The pin source is right: `packages/cli/src/templates/pinned/docker-compose.yml`, copies held by `scripts/compose-test-stack-copy.test.ts:36` |
| #1033 MCP: one token across tenants | windows, unit-1, packages 2/2, verify red | below |
| #1031 Biome 2.6.3 | merged | — |

## #1033 — Files to change
- `packages/testing/src/cdp-launch.ts` / `cdp-launch-attempt.ts:220` — the new `startsChrome` probe runs `chrome.exe --version`, which on Windows opens the GUI and never exits (15 s × 2 candidates = the 30 s timeout). Skip the probe on `win32` (the snap-wrapper case it solves is Linux-only) and give its `Bun.spawn` a `timeout:` — that also clears the `scripts/spawn-timeout.test.ts:128` ratchet without raising its pin.
- `packages/scraping/src/cdp-snapshot.e2e.test.ts` — drop its copy of `startsChrome`; import the one from `@ultimat3/testing`.
- `packages/mcp/src/tenant.ts` — decide and pin two semantics the security review raised (no escape found):
  - Scopes and role carry unchanged into every tenant (`{ ...caller, actor, tenant }`). Ruling: the app's `resolve` may narrow; document it in `packages/mcp/README.md`, with a test that a narrowing `resolve` takes effect.
  - Only `tools/call` passes through `tenantStep`. Add a test that `resources/read` on a tenant server fails closed at the tenant guard; fix it if it does not.
- Rebase onto `main` (Biome 2.6.3). The `noTemplateCurlyInString` lines are warnings; [`24-ci-gate.md`](24-ci-gate.md) silences them for test fixtures.

## Tests
- `bun test packages/testing/src/cdp-launch*.test.ts packages/mcp/src/tenant*.test.ts`
- `bun test scripts/spawn-timeout.test.ts`

## Done when
- #1028, #1029, #1033 merged; `gh pr list --state open` lists only PRs opened after this plan started.
