/**
 * The error both surfaces raise about WHO is calling — one, and it belongs to no feature.
 *
 * `NotAMember` sat here beside it until 2026-08-24 and has moved DOWN to `@postly/core`, next to
 * the `memberOf` whose `null` it refuses: `packages/mcp` needs the same refusal and a package
 * cannot import `apps/web/shared/`. This one stays, because `ActorFacts` is an `app/` concern and
 * nothing under `packages/` resolves them.
 */

// No `docs:` at any construction site below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { UltimateError } from '@ultimat3/core';

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
