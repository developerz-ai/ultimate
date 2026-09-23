/**
 * The record envelope, on the action's HTTP projection only. Derived from the output schema — an
 * action whose output references an entity row answers `{ data, records }` under
 * `x-ultimate-records: 1`; every other action's body is byte-identical to what it always was.
 */

import { encodeRecordEnvelope, RECORDS_HEADER } from '@ultimat3/core';
import { hasEntityRows, rowsOf } from '@ultimat3/entity';
import { json } from '@ultimat3/http';
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

/** The 200 for an action that carries records: the envelope, and the header that names it. */
export function recordResponse(output: StandardSchemaV1, result: unknown): Response {
  const response = json(encodeRecordEnvelope(result, rowsOf(output, result)));
  response.headers.set(RECORDS_HEADER, ENVELOPED);
  return response;
}
