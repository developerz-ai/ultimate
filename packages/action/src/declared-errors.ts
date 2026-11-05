// Single responsibility: the wrap `invoke` puts around `handle` and `row` for an action declaring
// `errors:`. Core owns the rule (`declared-errors.ts`, shared with `@ultimat3/query`) and
// `@ultimat3/http` the status; the static half is `declared-errors-contract.ts`.

import { withDeclaredErrors } from '@ultimat3/core';
import { declaredStatusFor } from '@ultimat3/http';
import type { AnyActionDef } from './action';

/** A throw out of `run` judged against `def.errors`. Undeclared, the call is `run` itself. */
export function judgedHandler<T>(def: AnyActionDef, name: string, run: () => T): Promise<T> | T {
  if (def.errors === undefined) return run();
  return withDeclaredErrors(def.errors, declaredStatusFor, { primitive: 'action', name }, run);
}
