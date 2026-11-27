/**
 * A read's input parse — `@ultimat3/action`'s `validate.ts` twin. Bounded by `@ultimat3/schema`'s
 * `MAX_ISSUES` (`validateAsync` stops collecting there), and the refusal carries the list a form
 * binds to plus `issuesTruncated`, so a hostile 10k-item input costs a hundred rejections.
 */

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toValidationIssues, validateAsync } from '@ultimat3/schema';
import { QueryInputInvalidError } from './errors';
import { reportUnknownInputKeys } from './validate-unknown-keys';

/**
 * `toValidationIssues`, never the raw `result.issues`: a conforming library's issue may carry the
 * rejected VALUE, and this list reaches the HTTP problem document.
 */
export async function parseQueryInput(
  schema: StandardSchemaV1,
  raw: unknown,
  name: string,
  callerInput = false,
): Promise<unknown> {
  const result = await validateAsync(schema, raw);
  if (result.issues === undefined) {
    // #1281: after the parse, never instead of it — the answer is unchanged, the warning says what
    // it dropped. `callerInput` is `read.ts`'s enforced build alone: `parsedQueryInput` parses the
    // same input again to KEY a live window, and an `unenforced` build re-reads input a caller
    // already sent, so either warning would be the same report twice.
    if (callerInput) reportUnknownInputKeys(schema, raw, name);
    return result.value;
  }
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
