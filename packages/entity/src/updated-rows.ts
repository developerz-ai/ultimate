// Single responsibility: `updateWhereReturning` for a repository whose write has no `returning`
// of its own — a `defineDriver` store, or a hand-written `Repo` — answered from the rows its
// `updateWhere` hands over (`search-written-rows.ts`), the same seam the search mirror reads.

import { describeCommand, EntityError } from './errors';
import { collectWrittenRows } from './search-written-rows';

/**
 * Run `write` (an `updateWhere`) and answer the rows it wrote. A write that matched nothing is
 * `[]`; one that wrote rows without handing them over — a store past the judged bound, or a
 * repository that never reports them — is refused rather than answered with a guess.
 */
export const updatedRows = async <Row>(
  entityName: string,
  write: () => Promise<number>,
): Promise<readonly Row[]> => {
  const { result, rows } = await collectWrittenRows(write);
  if (result === 0) return [];
  if (rows === undefined || rows.length !== result) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName}.updateWhereReturning() wrote ${result} rows and this repository named ${rows?.length ?? 0} of them — a write that matches that many rows (or a store that cannot report them) has no rows to hand back`,
      fix: `${describeCommand(entityName)}   # then write by a narrower filter, or sweep it with .where(filter).inBatches(1000) and write each page`,
    });
  }
  return rows as readonly Row[];
};
