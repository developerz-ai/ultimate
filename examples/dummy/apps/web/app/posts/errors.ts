/** Errors the posts feature can raise. Codes are stable; the message names the fix. */

import { UltimateError } from '@ultimat3/core';

export class PostNotFound extends UltimateError {
  constructor(reference: string) {
    super({
      code: 'X_POST_NOT_FOUND',
      cause:
        `no post ${JSON.stringify(reference)} in the actor's organisation — a reference owned ` +
        'by another org is a denial, never a 404 by accident',
      fix: 'psql "$DATABASE_URL" -c "SELECT id, slug FROM posts WHERE org_id = \'<ctx.actor.orgId>\'"',
      docs: 'https://ultimate.dev/errors/X_POST_NOT_FOUND',
    });
  }
}
