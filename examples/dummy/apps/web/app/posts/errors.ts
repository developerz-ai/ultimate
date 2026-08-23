/** Errors the posts feature can raise. Codes are stable; the message names the fix. */

// No `docs:` at any construction site below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { UltimateError } from '@ultimat3/core';

export class PostNotFound extends UltimateError {
  constructor(reference: string) {
    super({
      code: 'X_POST_NOT_FOUND',
      cause:
        `no post ${JSON.stringify(reference)} in the actor's organisation — a reference owned ` +
        'by another org is a denial, never a 404 by accident',
      fix: 'psql "$DATABASE_URL" -c "SELECT id, slug FROM posts WHERE org_id = \'<ctx.actor.orgId>\'"',
    });
  }
}
