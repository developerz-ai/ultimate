/** Business-rule error codes. Each one names the fix, because agents read these, not stack traces. */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.
//
// No `CoreError` base any more: a family is a code prefix (`X_BILLING_*`), and a catch tells one
// code from another with `SeatsExceeded.is(error)` — which also holds for the browser's rebuilt
// refusal, where `instanceof` cannot.

import { defineError } from '@ultimat3/core/page';

/**
 * The actor carries no membership, so nothing in this app can decide about them or write a row
 * owned by them. Every surface that reaches a service is gated by a policy that already refuses
 * such an actor — this is the refusal for a caller that arrived from a job, an MCP tool or a test
 * instead.
 *
 * It lives HERE, beside `memberOf`, and not in `apps/web/shared/errors.ts`, where it was until
 * 2026-08-24: `memberOf` is the function that answers `null`, and this is that `null` refused, so
 * every reader of one is a reader of the other. `packages/mcp` is the reader that proved it —
 * `ctx.orgs` and `ctx.posts` could reach `apps/web/shared/`, and a package under `packages/`
 * cannot. One declaration, one code; a second of either would be a second way to say one thing.
 */
export const NotAMember = defineError<string>({
  code: 'X_ORG_NOT_A_MEMBER',
  title: 'the actor holds no membership in any org',
  status: 403,
  cause: (actorId) => `actor ${JSON.stringify(actorId)} carries no org and no membership role`,
  // Runnable, not advice: the caller either has a membership row or does not, and this names
  // the read that answers it. `actorFor(member)` is what a test does with the row it finds.
  fix:
    'read the membership row with memberById(orgId, id) from apps/web/app/orgs/repo.ts, ' +
    'then build the actor with actorFor(member)',
});

export const SeatsExceeded = defineError<{
  readonly plan: string;
  readonly limit: number;
  readonly requested: number;
}>({
  code: 'X_BILLING_SEATS_EXCEEDED',
  title: "the plan's seats are all taken",
  status: 409,
  cause: (d) => `plan "${d.plan}" allows ${d.limit} seats; ${d.requested} requested`,
  fix: 'call upgradePlan before inviteMember, or remove a member first',
  // The how-to an agent reads next: `packages/mcp/src/tools.ts` serves it, and the load check
  // refuses this link the day that recipe is renamed (`X_MCP_RECIPE_UNKNOWN`).
  docs: 'docs://recipes/make-room-for-a-member',
});

export const NotAnUpgrade = defineError<{ readonly from: string; readonly to: string }>({
  code: 'X_BILLING_NOT_AN_UPGRADE',
  title: 'the plan change is not an upgrade',
  status: 422,
  cause: (d) =>
    `"${d.from}" → "${d.to}" is not an upgrade; downgrades and refunds are a separate flow`,
  fix: 'use the scheduled-downgrade flow so the current period is honoured',
});
