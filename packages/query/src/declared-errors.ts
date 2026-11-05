// Single responsibility: the judgement the read path puts around `sql` and the source's `execute`
// for a query declaring `errors:` — core's rule (`declared-errors.ts`, shared with
// `@ultimat3/action`), `@ultimat3/http`'s status. Undeclared, each call is the read itself.

import type { DeclaredErrorsOwner } from '@ultimat3/core';
import { enforceDeclared, withDeclaredErrors } from '@ultimat3/core';
import { declaredStatusFor } from '@ultimat3/http';
import type { AnyQuery } from './query';

const ownerOf = (name: string): DeclaredErrorsOwner => ({ primitive: 'query', name });

/** `sql(input, ctx)`, which builds a source synchronously: a throw from it is judged here. */
export function judgedSql<T>(target: AnyQuery, name: string, build: () => T): T {
  if (target.errors === undefined) return build();
  try {
    return build();
  } catch (error) {
    throw enforceDeclared(error, target.errors, declaredStatusFor, ownerOf(name));
  }
}

/** The source's `execute()`: the same promise when undeclared, a judged one otherwise. */
export function judgedRead<T>(target: AnyQuery, name: string, run: () => Promise<T>): Promise<T> {
  if (target.errors === undefined) return run();
  return withDeclaredErrors(target.errors, declaredStatusFor, ownerOf(name), run);
}
