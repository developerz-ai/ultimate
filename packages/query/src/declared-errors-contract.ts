// Single responsibility: `.contract()`'s assertion for a query declaring `errors:` — the codes its
// `sql` names in its own source, judged by core's rule (the action's twin, one tier over). First
// hop only: what a repository helper throws is the read path's wrap to judge (`declared-errors.ts`).

import {
  definedErrorClassCodes,
  ErrorUndeclaredError,
  judgeThrown,
  scanHandlerSource,
} from '@ultimat3/core';
import { declaredStatusFor } from '@ultimat3/http';
import type { QueryContractTest } from './contract-test';
import type { AnyQuery } from './query';
import { defOf, queryName } from './read';

/** One assertion for a read that declares `errors:`; none for an open contract or a download. */
export function declaredErrorsContract(target: AnyQuery): readonly QueryContractTest[] {
  const declared = target.errors;
  if (declared === undefined || target.download === true) return [];
  const name = queryName(target);
  return [
    {
      name: `${name}: its read names only the errors it declares`,
      run: async () => {
        const stray = scanHandlerSource(
          defOf(target).sql.toString(),
          await definedErrorClassCodes(),
        ).filter((code) => judgeThrown(declared, code, declaredStatusFor(code)) === 'undeclared');
        if (stray.length === 0) return;
        throw new ErrorUndeclaredError({ primitive: 'query', name }, stray.join("', '"));
      },
    },
  ];
}
