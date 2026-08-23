// The class every realtime error extends, and nothing else.
//
// Apart from `errors.ts` so a concern-specific error module can extend it WITHOUT importing the
// code table — `errors.ts` re-exports both, so `RealtimeError` and every subclass stay importable
// from where they always were. Its own file rather than a re-export inside `errors.ts`, because
// that would be a cycle: `extends` runs at module evaluation, imports hoist above it, and the base
// would be in its temporal dead zone by the time the subclass module was evaluated.

import { UltimateError } from '@ultimat3/core';
import type { RealtimeErrorCode } from './errors';

/**
 * Base for every realtime error. No `docs:` — `UltimateError` fills it from
 * `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL`: one page for every
 * code, never one per code, because `wiki/` is the framework's only public documentation surface
 * and a code lives there in a TABLE ROW, which has no anchor. The
 * `https://ultimate.dev/errors/<code>` links this class built until 9.x answered 404, host
 * included, on every error it has ever thrown — including the ones `toWireError` puts on the wire.
 */
export class RealtimeError extends UltimateError {
  constructor(opts: { code: RealtimeErrorCode; cause: string; fix: string }) {
    super({
      code: opts.code,
      cause: opts.cause,
      fix: opts.fix,
    });
  }
}
