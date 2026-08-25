/**
 * Schema validation for every surface. One code path covers HTTP, MCP, jobs and
 * direct server calls, so all four reject the same payload with the same code
 * and the same issue text — on the way in and on the way out.
 */

import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toValidationIssues, validateAsync } from '@ultimat3/schema';
import { InputInvalidError, OutputInvalidError } from './errors';

/**
 * The refusal carries the issue list as well as the line, and the two are ONE value rendered twice:
 * `formatIssues` reads `path` and `message`, which is exactly what `toValidationIssues` copied out
 * of the library's own issues, so the string is byte-identical to the one this threw before.
 *
 * `toValidationIssues`, never the raw `result.issues`: a conforming library's issue object may
 * carry members Ultimate's shape does not — including the rejected VALUE — and this list is
 * handed to an HTTP surface that returns it to the caller. Four members travel, and
 * `describeValue` is what keeps a value out of the fifth.
 */
export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  raw: unknown,
  actionName: string,
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, raw);
  if (result.issues !== undefined) {
    const issues = toValidationIssues(result.issues);
    throw new InputInvalidError(actionName, formatIssues(issues).join('; '), issues);
  }
  return result.value;
}

/**
 * The handler's return value is data too. Parsing it is what makes the OpenAPI
 * response schema, the typed client and the MCP `outputSchema` true rather than
 * documentation — a handler that drifts from `output` fails on its own call.
 */
export async function validateOutput<S extends StandardSchemaV1>(
  schema: S,
  produced: unknown,
  actionName: string,
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, produced);
  if (result.issues !== undefined) {
    throw new OutputInvalidError(actionName, formatIssues(result.issues).join('; '));
  }
  return result.value;
}
