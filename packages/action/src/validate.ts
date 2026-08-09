/**
 * Schema validation for every surface. One code path covers HTTP, MCP, jobs and
 * direct server calls, so all four reject the same payload with the same code
 * and the same issue text — on the way in and on the way out.
 */

import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import { InputInvalidError, OutputInvalidError } from './errors';

export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  raw: unknown,
  actionName: string,
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, raw);
  if (result.issues !== undefined) {
    throw new InputInvalidError(actionName, formatIssues(result.issues).join('; '));
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
