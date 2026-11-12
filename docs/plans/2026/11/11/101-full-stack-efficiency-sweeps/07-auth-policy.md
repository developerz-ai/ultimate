# 07 — auth and policy: one round trip to authenticate, visibility the database can index

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-entity.md) for the `where` shape P1 hands down. Tier: 2 (`auth`, `policy`), then `query` (tier 3) composes P1.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| A1 | P2 | plausible (read; not measured) | `packages/auth/src/auth.ts:397-405` | Every authenticated request makes two sequential round trips: `verifySession` → `getSession`, then `adapter.findUserById`. One join answers both and still re-reads the user row each request (the "never cache the user" rule holds) | optional adapter member `getSessionWithUser(id)` in `builtin-adapter.ts` and `memory-adapter.ts`; `authenticate` uses it when present, falls back otherwise. `authAdapterConformance` pins parity. Secret and expiry checks unchanged. Measure first with the `statements` fixture: 2 → 1 |
| P1 | P2 | plausible; seen in the deployed demo | `dummy/social-media-clone/apps/web/site/feed/service.ts:56-63`, `site/u/service.ts:46-50`; `packages/policy/src/policy.ts` | Row visibility is evaluated in JS after a ×3 over-fetch: a viewer with many hidden rows gets a short page, and the database cannot use an index for the predicate. A policy cannot hand down a SQL predicate | optional `scope(actor) → where` on a policy: the entity chain's predicate shape, composed by `query()` into the read. The JS rule stays the authority and runs on the returned rows as the proof — one definition, two projections (axiom 2). A policy with `scope` whose SQL and JS disagree on the exercise seed is a finding: new code, `X_POLICY_SCOPE_MISMATCH`, raised by the exercise step |

Checked and fine, not planned: SAML (wrapping, comment injection, key source), argon2 off the event loop behind `kdfGate` (8 running, 64 queued), session `lastSeenAt` and API-key `lastUsedAt` writes throttled, `policy/evaluate.ts` trace opt-in, grant index memoised per actor.

Not read in three passes: OAuth/OIDC internals, passkeys, the authorization server. The sweep's `security-auditor` pass is scoped to exactly those three ([`overview.md`](overview.md) *Risks*).

## Files to change
- `packages/auth/src/adapter.ts`, `builtin-adapter.ts`, `memory-adapter.ts`, `session.ts`, `auth.ts`; `packages/testing/src/auth-adapter-conformance.ts`.
- `packages/policy/src/policy.ts`, `scope.ts` (new), `index.ts`; `packages/query/src/read.ts` (compose the scope; lock shared with [`08`](08-action-query.md): one worker holds `query/`).
- `packages/cli/src/exercise-findings.ts` — the mismatch finding (lock shared with [`13`](13-cli-exercise-verify.md): schedule P1's cli part in that sweep).
- `packages/auth/README.md`, `packages/policy/README.md`, both `CLAUDE.md`; `wiki/Policies.md`.
- Coordinator only: `bun run new-error-code X_POLICY_SCOPE_MISMATCH --package policy …`, changelog, `bun run manifest`.

## Steps
1. A1: statements fixture red at 2, then the join.
2. P1 in three parts across sweeps: the `scope` shape in `policy` (this sweep); composition in `query` ([`08`](08-action-query.md)'s sweep); the parity finding in exercise ([`13`](13-cli-exercise-verify.md)'s sweep). The demo adopts it in [`18`](18-tracked-apps.md).
3. Tenant scoping is not `scope`: tenancy stays the entity layer's. State it in `wiki/Policies.md` so nobody builds tenancy on it.

## Tests
- Conformance: the same actor through both adapter paths; `statements` asserts 1 per authenticate on the builtin adapter.
- `packages/policy/src/scope.test.ts` — the composed predicate for an anonymous viewer, a member, an admin.
- `packages/query/src/read-scope.test.ts` — a scoped read returns a full page when hidden rows precede visible ones; the JS rule still runs on every returned row.
- Exercise fixture: a policy whose `scope` admits a row the rule refuses → `X_POLICY_SCOPE_MISMATCH`.
- Command: `bun test ./packages/auth/src/<file>.test.ts`.

## Done when
- One statement per authenticate on the builtin adapter.
- The demo's feed reads exactly one page of rows for any viewer ([`18`](18-tracked-apps.md)), index-served.
- A drifting `scope` cannot pass the gate.

## Outcome

As of 2026-11-12, sweep 5b, for 31.10.0.

| # | Verdict | What shipped, or why not |
|---|---|---|
| A1 | shipped | optional `AuthAdapter.getSessionWithUser(id)` (`SessionWithUser`) on both shipped adapters; `authenticate` uses it, else the two reads (`session-user.ts`, `admitSession` the one copy of the secret and clock checks). 2 → 1 statement on `postgresAuthAdapter`, counted on PGlite (`authenticate-statements.test.ts`); parity in `authAdapterConformance` |
| P1 | partial — shape only | `scoped(policy, scope)` / `policyScope(policy, actor)` (`scope.ts`): AND-only `ScopeCondition`s in the entity predicate shape; `and`/`or`/`not` carry no child's scope. Composition into `query` reads is [`08`](08-action-query.md)'s sweep; `X_POLICY_SCOPE_MISMATCH` is [`13`](13-cli-exercise-verify.md)'s and is not registered yet |
| ledger | shipped | `registerClient` refuses empty or whitespace-holding list values (`X_AUTH_CLIENT_INVALID`, 422); `x_auth_lockouts` is rendered from the declared `AUTH_LOCKOUTS_STORAGE`, which the framework schema's drift check now reads instead of a copy (no schema dump moved) |
