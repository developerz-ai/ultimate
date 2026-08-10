/** Errors the posts feature can raise. Codes are stable; the message names the fix. */

import { UltimateError } from '@ultimat3/core';

export class PostNotFound extends UltimateError {
  constructor(reference: string) {
    super({
      code: 'X_POST_NOT_FOUND',
      cause: `no post ${JSON.stringify(reference)} in the actor's organisation`,
      fix: 'pass an id or slug owned by ctx.actor.orgId — cross-org reads are denials, not 404s by accident',
      docs: 'https://ultimate.dev/errors/X_POST_NOT_FOUND',
    });
  }
}
