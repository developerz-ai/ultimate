// Single responsibility: `.contract()`'s assertion for an action declaring `errors:` — the codes its
// `handle` and `row` name in their own source, judged by core's rule. First hop only: what a
// helper throws is the dynamic half's (`declared-errors.ts`), reached by any test of the path.

import {
  definedErrorClassCodes,
  ErrorUndeclaredError,
  judgeThrown,
  scanHandlerSource,
} from '@ultimat3/core';
import { declaredStatusFor } from '@ultimat3/http';
import type { AnyAction } from './action';
import type { ContractTest } from './contract-test';
import { defOf } from './invoke';

/**
 * The static half: one assertion, only for an action that declares `errors:`. A code literal or a
 * `defineError` class in `handle`'s or `row`'s own source, 4xx and outside the list, is red here
 * whether or not a test reaches the line. First hop only — a helper is the dynamic half's.
 */
export function declaredErrorsContract(target: AnyAction, name: string): readonly ContractTest[] {
  const def = defOf(target);
  if (def.errors === undefined) return [];
  const declared = def.errors;
  return [
    {
      name: `${name}: its handler names only the errors it declares`,
      run: async () => {
        const source = `${def.handle.toString()}\n${def.row?.toString() ?? ''}`;
        const stray = scanHandlerSource(source, await definedErrorClassCodes()).filter(
          (code) => judgeThrown(declared, code, declaredStatusFor(code)) === 'undeclared',
        );
        if (stray.length === 0) return;
        throw new ErrorUndeclaredError({ primitive: 'action', name }, stray.join("', '"));
      },
    },
  ];
}
