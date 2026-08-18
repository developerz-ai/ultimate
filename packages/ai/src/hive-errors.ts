// The X_HIVE_* codes, apart from ./errors only because one file has one job and that catalogue is
// already at its ceiling — the same split `eval-errors.ts` made. The codes, their titles and the
// single `registerErrorCodes` call stay in ./errors: one owner, one registration, one place a
// duplicate can surface.

import { UltimateError } from '@ultimat3/core';
import type { AiErrorCode } from './errors';

const docsFor = (code: AiErrorCode): string => `https://ultimate.dev/errors/${code}`;

/**
 * `split` handed back an empty list, so the hive fanned out to nobody and would have reported a
 * successful run of zero members.
 *
 * Refused rather than returned, because the two readings of "0 ok, 0 failed" are "there was
 * genuinely nothing to do" and "the query behind `split` returned no rows and nobody noticed",
 * and only the caller can tell them apart. A hive whose empty case is legitimate says so by not
 * being called: guard the `split` source at the call site, where the emptiness is visible.
 */
export class HiveEmptyError extends UltimateError {
  constructor(input: { member: string }) {
    super({
      code: 'X_HIVE_EMPTY',
      cause: `the hive over "${input.member}" split into 0 members, so no member ran`,
      fix: `return at least one member input from the hive's split() over "${input.member}", or skip the hive call when the source is empty — a hive reporting 0 ok and 0 failed cannot be told apart from one whose query returned no rows`,
      docs: docsFor('X_HIVE_EMPTY'),
      meta: { member: input.member },
    });
  }
}
