/**
 * Errors both surfaces can raise about WHO is calling. Two, and neither belongs to a feature:
 * `memberOf` is `@postly/core`'s and every service asks it the same question.
 */

// No `docs:` at any construction site below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { UltimateError } from '@ultimat3/core';

/**
 * The actor carries no membership, so nothing in this app can decide about them or write a row
 * owned by them. Every surface that reaches a service is gated by a policy that already refuses
 * such an actor — this is the refusal for a caller that arrived from a job or a test instead.
 *
 * It lives here rather than in a feature because `ctx.orgs` and `ctx.posts` both need the same
 * answer, and a second class with a second code would be a second way to say one thing. The code
 * is unchanged from when it lived in `app/orgs/errors.ts`.
 */
export class NotAMember extends UltimateError {
  constructor(actorId: string) {
    super({
      code: 'X_ORG_NOT_A_MEMBER',
      cause: `actor ${JSON.stringify(actorId)} carries no org and no membership role`,
      // Runnable, not advice: the caller either has a membership row or does not, and this names
      // the read that answers it. `actorFor(member)` is what a test does with the row it finds.
      fix:
        'read the membership row with memberById(orgId, id) from apps/web/app/orgs/repo.ts, ' +
        'then build the actor with actorFor(member)',
    });
  }
}

/**
 * Raised by `useActor()` when nothing resolved the app's actor facts for this request.
 *
 * A named failure rather than `undefined.name` in a heading, because the states are not
 * distinguishable downstream: an actor minted by a job, a test or an MCP token exchange carries no
 * member row either, and each is a legitimate actor the `app/` surface simply cannot render for.
 * `ActorFacts` is optional per key on purpose (`packages/core/src/actor.ts`) — an unresolved fact
 * is `undefined`, so this is where "nobody resolved it" becomes an instruction.
 */
export class ActorUnresolved extends UltimateError {
  constructor() {
    super({
      code: 'X_ACTOR_UNRESOLVED',
      cause:
        'the request actor carries no `member`/`org` fact, so app/ has no member row to render — ' +
        'an anonymous, job or agent actor reads exactly the same way',
      fix: 'mint the request actor with postlyActor({ member, org }) from apps/web/shared/actor.ts',
    });
  }
}
