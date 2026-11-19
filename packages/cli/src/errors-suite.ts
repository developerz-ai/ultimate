// `x test` over a selection that matched nothing. Its fix never prints the bare command: pasted as
// printed, that starts every suite, which a worker on a file set must not (`wiki/Many-Agents.md`).

import { UltimateError } from '@ultimat3/core';

/**
 * `x test` discovered nothing. A green run over zero files is the most expensive false pass, so
 * the selection that found nothing is named in full — a caller that cannot see whether the type
 * or the filter emptied the set has to guess which one to drop.
 */
export class NoTestFilesError extends UltimateError {
  constructor(input: { root: string; type?: string; filter?: string }) {
    const parts = [
      input.type === undefined ? undefined : `of type ${input.type}`,
      input.filter === undefined ? undefined : `matching "${input.filter}"`,
    ].filter((part): part is string => part !== undefined);
    const where = parts.length === 0 ? '' : ` ${parts.join(' ')}`;
    super({
      code: 'X_TEST_NO_FILES',
      cause: `no *.test.ts files${where} under ${input.root}`,
      fix:
        parts.length === 0
          ? 'x test --json   # run it from the repo root'
          : 'x test --affected --dirty   # the tests your edits reach; or a path that exists: x test --filter <path>',
    });
  }
}
