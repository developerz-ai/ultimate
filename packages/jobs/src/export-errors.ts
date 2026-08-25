// The two `X_EXPORT_*` codes an export pass can end on, apart from `errors.ts` for the reason
// `backfill-errors.ts` and `webhook-errors.ts` are: one file, one job, and `errors.ts` holds the
// registry — the codes, the titles and the single `registerErrorCodes()` call.
//
// Both are TERMINAL and both are refusals of the DECLARATION rather than of the data: the same
// `row()` over the same page answers the same way on every attempt, so retrying spends a policy
// proving it.

import { UltimateError } from '@ultimat3/core';

/**
 * `row()` answered something the declaration did not promise: a column missing, a column nobody
 * declared, or a value no format can carry.
 *
 * The extra-column half is the one worth the code. A `row()` that returns a key `columns` omits is
 * silently DROPPED by both encoders — so an export that was supposed to carry a column carries the
 * rest of the file looking perfectly correct, and the gap is found by whoever consumes it, later.
 * The reverse — a column nobody declared — is how PII leaves through an export nobody reviewed:
 * `row: (r) => ({ ...r })` picks up every column the entity gains from then on.
 *
 * `cause` names the COLUMN and never the value: a cell is user data by definition, and a cause
 * reaches the log store as a field nothing can redact.
 */
export class ExportRowInvalidError extends UltimateError {
  constructor(input: { export: string; column: string; reason: string }) {
    super({
      code: 'X_EXPORT_ROW_INVALID',
      cause: `export "${input.export}" row() answered a "${input.column}" that ${input.reason}`,
      fix: `return exactly the declared columns from row() on exportRows("${input.export}"), each one a string, a finite number, a boolean or null — format a date with an explicit timeZone and a Money with its own currency before it gets here`,
      meta: { column: input.column },
    });
  }
}

/**
 * One page encoded to more bytes than a part may hold. The memory bound made mechanical: this
 * factory exists because accumulating a result set before writing it is the failure it prevents,
 * and "we hold a page, not a dataset" is only true while a page is bounded. A row that is a
 * megabyte of JSON turns `batch: 1_000` into a gigabyte in one buffer.
 */
export class ExportPartTooLargeError extends UltimateError {
  constructor(input: { export: string; part: number; bytes: number; maxBytes: number }) {
    super({
      code: 'X_EXPORT_PART_TOO_LARGE',
      cause: `export "${input.export}" part ${input.part} encoded to ${input.bytes} bytes and a part may hold ${input.maxBytes}`,
      fix: `lower batch on exportRows("${input.export}") until a page fits, or raise maxPartBytes if this deployment really can hold that much per part — the number is a heap bound, not a file-size preference`,
      meta: { part: input.part, bytes: input.bytes, maxBytes: input.maxBytes },
    });
  }
}
