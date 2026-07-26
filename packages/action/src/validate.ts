/**
 * Input validation for every surface. One code path covers HTTP, MCP, jobs and
 * direct server calls, so all four reject the same payload with the same code
 * and the same issue text.
 */

import type { InferOutput, StandardIssue, StandardSchemaV1 } from '@ultimat3/schema';
import { formatPath, validateAsync } from '@ultimat3/schema';
import { InputInvalidError } from './errors';

export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  raw: unknown,
  actionName: string,
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, raw);
  if (result.issues !== undefined) {
    throw new InputInvalidError(actionName, formatIssues(result.issues));
  }
  return result.value;
}

/** Deterministic, one-line rendering — same text in terminal, overlay and `--json`. */
export function formatIssues(issues: readonly StandardIssue[]): string {
  return issues
    .map((issue) => {
      const path = formatPath(issue.path);
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
