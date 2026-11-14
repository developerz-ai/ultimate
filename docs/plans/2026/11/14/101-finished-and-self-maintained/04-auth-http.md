# 04 — auth: the member-invite flow

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db-entity-policy.md). Tier: 2.

## Files to change
- `packages/auth/src/verification-purposes.ts:30` — only `defineVerificationPurpose('member-invite')` exists; no flow. `wiki/Shapes.md:59-61`: the `saas` shape waits on it.
- `packages/auth/src/` (new `member-invite.ts` + test) — the flow.
- `packages/cli/src/` generator templates — `x g` for the invite pages.
- `wiki/Auth.md`, `wiki/Shapes.md`.

## Steps
1. Primitive: `action`. Ship the flow as factories returning actions (invite, accept, revoke, resend) over the existing verification purpose and tenant membership — one `PRIMITIVE_FACTORIES` row, no new kind.
2. Structural only: who may invite, seat limits and roles offered are the app's `policy` and the app's wrapper. The framework ships token lifetime, single use, tenant binding, replay refusal, and session revocation on revoke (`revokeOrgSessions`).
3. Errors: reuse existing auth codes; a new one only for a state none covers, via `bun run new-error-code`.
4. Decision recorded, not built: a PIN / device-operator method (one adopter, 2 files) stays an app wrapper over the authenticator; add it as a recipe in `wiki/Building-Your-Own-Base.md` ([`13`](13-shapes-and-declaration.md)). [`90`](90-owner-decisions.md) OD6.

## Tests
- `bun test ./packages/auth/src/member-invite.test.ts` — expired, reused, cross-tenant and revoked tokens each refused with their code.
- Tenant proof: an invite for tenant X never yields membership in Y (property test).
- `security-auditor` pass on the diff.

## Done when
- `x g` scaffolds invite pages that pass `x verify` in a fresh app.
- `wiki/Shapes.md` no longer lists invites as blocking `saas`.
