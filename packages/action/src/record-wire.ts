/**
 * The action's 200 on the HTTP projection. Derived from the output schema — an action whose output
 * references an entity row answers `{ data, records }` under `x-ultimate-records: 1`; every other
 * action's body is byte-identical to what it always was. Either names its instants by path.
 */

import { DATES_HEADER, encodeRecordEnvelope, RECORDS_HEADER, wireDatePaths } from '@ultimat3/core';
import { hasEntityRows, rowsOf } from '@ultimat3/entity';
import { jsonResponse } from '@ultimat3/http';
import type { StandardSchemaV1 } from '@ultimat3/schema';

/** The header value that says "this body is an envelope". Presence alone is not enough. */
const ENVELOPED = '1';

// The OpenAPI half — the 200 body and its header — is core's `recordEnvelopeSchema` and
// `RECORDS_OPENAPI_HEADER`, shared with `@ultimat3/query` so both projections describe one shape.

/**
 * Decided ONCE per action, at projection, from the schema — never per response from the data.
 * A body whose shape depended on whether this call happened to return rows would need two
 * OpenAPI shapes for one operation; a schema-derived answer needs exactly one.
 */
export function carriesRecords(output: StandardSchemaV1): boolean {
  return hasEntityRows(output);
}

/**
 * The output's instants — `@ultimat3/core`'s `wire-dates.ts`, the rule `@ultimat3/query`'s
 * `record-answer.ts` follows — so the typed client hands back the `Date` the output type promises.
 * A header, never the body: an old client reads the ISO string it always read.
 */
function datesOf(result: unknown): { readonly headers: Record<string, string> } {
  const dates = wireDatePaths(result);
  return { headers: dates === undefined ? {} : { [DATES_HEADER]: dates } };
}

/** The 200 for an action that carries no records: the output itself. */
export function plainResponse(result: unknown): Response {
  return jsonResponse(result, datesOf(result));
}

/**
 * The 200 for an action that carries records: the envelope, and the header that names it. The
 * paths are the DATA's, as on a read: the client revives the envelope's `data`, never `records`.
 */
export function recordResponse(output: StandardSchemaV1, result: unknown): Response {
  return jsonResponse(encodeRecordEnvelope(result, rowsOf(output, result)), {
    headers: { [RECORDS_HEADER]: ENVELOPED, ...datesOf(result).headers },
  });
}
