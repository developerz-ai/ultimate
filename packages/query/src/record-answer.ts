/**
 * A read's HTTP answer. Decided ONCE per query, at projection, from its `rows:` schema — the rule
 * `@ultimat3/action`'s `record-wire.ts` already follows: a query whose `rows:` is an entity row
 * schema ALWAYS answers `{ data, records }` behind `x-ultimate-records: 1` (records may be `{}`),
 * and every other query answers the bare rows (or `Page`) it always did. One body shape per
 * operation — until 21.0.0 a read sent the envelope only when a row came back, so its OpenAPI was a
 * `oneOf` over "sometimes" and a generated client had to branch on the data.
 */

import type { RecordRows, Row } from '@ultimat3/core';
import { encodeRecordEnvelope, RECORDS_HEADER } from '@ultimat3/core';
import { hasEntityRows, rowsOf } from '@ultimat3/entity';
import { json } from '@ultimat3/http';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Page } from './pagination';

/** Turns one read's answer into its response. Built once per route, never per request. */
export type RecordAnswer = (answer: readonly object[] | Page<object>) => Response;

/**
 * `undefined` or an unbranded schema answers the plain `json()` it always did. The rows are
 * collected one at a time against the ROW schema, since the answer's own shape — an array or a
 * `Page` — is the route's, not the declaration's.
 */
export function recordAnswerFor(rows: StandardSchemaV1 | undefined): RecordAnswer {
  if (!answersRecords(rows)) return (answer) => json(answer);
  return (answer) => {
    const records = collect(rows, isPage(answer) ? answer.rows : answer);
    return json(encodeRecordEnvelope(answer, records), { headers: { [RECORDS_HEADER]: '1' } });
  };
}

/** The one predicate the route and the OpenAPI projection both ask: can this read answer records? */
export function answersRecords(rows: StandardSchemaV1 | undefined): rows is StandardSchemaV1 {
  return rows !== undefined && hasEntityRows(rows);
}

/** `Array.isArray` does not narrow a `readonly` array out of a union, so this says it once. */
function isPage(answer: readonly object[] | Page<object>): answer is Page<object> {
  return !Array.isArray(answer);
}

/**
 * Every entity row across the answer's rows: record type -> record key -> row. First sighting wins,
 * `rowsOf`'s own rule — one record shown twice is one record. Built in `Map`s and handed out as
 * null-prototype objects: a record type and a record key are data, and `__proto__` must stay a key.
 */
function collect(
  schema: StandardSchemaV1,
  list: readonly object[],
): Readonly<Record<string, RecordRows>> {
  const out = new Map<string, Map<string, Row>>();
  for (const row of list) {
    for (const [type, byKey] of Object.entries(rowsOf(schema, row))) {
      const bucket = out.get(type) ?? new Map<string, Row>();
      out.set(type, bucket);
      for (const [key, found] of Object.entries(byKey))
        if (!bucket.has(key)) bucket.set(key, found);
    }
  }
  return nullProto([...out].map(([type, bucket]) => [type, nullProto(bucket)] as const));
}

function nullProto<V>(entries: Iterable<readonly [string, V]>): Readonly<Record<string, V>> {
  const target = Object.create(null) as Record<string, V>;
  for (const [key, value] of entries) target[key] = value;
  return target;
}
