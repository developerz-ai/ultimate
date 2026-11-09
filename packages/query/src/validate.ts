/**
 * A read's input parse — `@ultimat3/action`'s `validate.ts` twin. Bounded by `@ultimat3/schema`'s
 * `MAX_ISSUES` (`validateAsync` stops collecting there), and the refusal carries the list a form
 * binds to plus `issuesTruncated`, so a hostile 10k-item input costs a hundred rejections.
 */

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toValidationIssues, validateAsync } from '@ultimat3/schema';
import { QueryInputInvalidError } from './errors';

/**
 * `toValidationIssues`, never the raw `result.issues`: a conforming library's issue may carry the
 * rejected VALUE, and this list reaches the HTTP problem document.
 */
export async function parseQueryInput(
  schema: StandardSchemaV1,
  raw: unknown,
  name: string,
): Promise<unknown> {
  const result = await validateAsync(schema, raw);
  if (result.issues === undefined) return result.value;
  const issues = toValidationIssues(result.issues);
  throw new QueryInputInvalidError(
    name,
    formatIssues(issues).join('; '),
    issues,
    result.issuesTruncated === true,
  );
}

/** The parse without the refusal — only for the record of a read already refused on other grounds. */
export async function parsedOrNothing(schema: StandardSchemaV1, raw: unknown): Promise<unknown> {
  const result = await validateAsync(schema, raw);
  return result.issues === undefined ? result.value : undefined;
}
