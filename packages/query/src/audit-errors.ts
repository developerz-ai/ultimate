/**
 * The two ways an audited read fails because of its audit, and nothing else. Their own module so
 * `errors.ts` keeps one job — the codes' TITLES are registered there, with every other code this
 * package owns — and so a read that declares no audit never constructs either.
 */

import { UltimateError } from '@ultimat3/core';

/**
 * `audit: true` with no sink installed. Raised before the input is parsed and before anything is
 * read — the twin of `@ultimat3/action`'s `X_AUDIT_SINK_MISSING`, and for the same reason there is
 * no logger-backed default to fall back on: a line nobody stores would satisfy the declaration
 * while recording nothing, which for a read is "who saw what" silently answered "nobody".
 */
export class QueryAuditSinkMissingError extends UltimateError {
  constructor(query: string) {
    super({
      code: 'X_QUERY_AUDIT_SINK_MISSING',
      cause: `query "${query}" declares \`audit: true\` and no audit sink is installed`,
      // The registered fix, verbatim: code first, so the line can be pasted (`wiki/Error-Codes.md`).
      fix: 'setAuditSink(sink)   # from @ultimat3/core, at boot before defineApi()',
    });
  }
}

/**
 * The sink refused the record of a read that SUCCEEDED, so the rows are withheld. The opposite of
 * the action twin's position on one point: an action's handler had already committed and only the
 * record is missing, while a read has changed nothing — so refusing the answer costs one retry,
 * and handing back rows nobody recorded is exactly the gap an audited read exists to close.
 */
export class QueryAuditSinkFailedError extends UltimateError {
  constructor(query: string, sourceError: unknown) {
    super({
      code: 'X_QUERY_AUDIT_SINK_FAILED',
      cause: `"${query}" was read and its audit sink refused the record, so the rows were withheld — a read commits nothing, so nothing is left to reconcile`,
      // The sink's own error is `sourceError`; a read commits nothing, so the retry is safe.
      fix: 'setAuditSink(sink)   # install a sink that accepts the record, then retry the read',
      meta: { query },
      sourceError,
    });
  }
}
