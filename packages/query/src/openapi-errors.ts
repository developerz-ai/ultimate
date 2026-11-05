// Single responsibility: a read operation's `responses` with its declared `errors:` in them —
// core's builder, bound to `@ultimat3/http`'s status table and Problem `type`; the `Problem` ref is
// `openapi.ts`'s own, handed in. Undeclared, the members are today's.

import { withDeclaredResponses } from '@ultimat3/core';
import { declaredStatusFor, problemTypeFor } from '@ultimat3/http';
import type { AnyQuery } from './query';

export function withDeclaredErrors(
  target: AnyQuery,
  problemRef: string,
  responses: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return withDeclaredResponses(responses, target.errors, {
    statusOf: declaredStatusFor,
    typeFor: problemTypeFor,
    problemRef,
  });
}
