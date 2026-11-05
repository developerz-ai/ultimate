// Single responsibility: an action operation's `responses` with its declared `errors:` in them —
// core's builder, bound to `@ultimat3/http`'s status table and Problem `type`, and to this
// document's `Problem` component. Undeclared, the members are today's.

import { withDeclaredResponses } from '@ultimat3/core';
import { declaredStatusFor, problemTypeFor } from '@ultimat3/http';
import { PROBLEM_SCHEMA_NAME, schemaRef } from './naming';

export function withDeclaredErrors(
  errors: readonly string[] | undefined,
  responses: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return withDeclaredResponses(responses, errors, {
    statusOf: declaredStatusFor,
    typeFor: problemTypeFor,
    problemRef: schemaRef(PROBLEM_SCHEMA_NAME),
  });
}
