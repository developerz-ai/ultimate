/**
 * The records envelope: an action's or a query's answer plus the entity rows it touched, so the
 * page's one store adopts them on the way past. Used ONLY behind `RECORDS_HEADER`, which is what
 * keeps an output with no entity rows byte-identical on the wire. Pure and schema-free — the rows
 * are validated by whoever owns the sink, never here.
 */

import type { Row } from './conflict-policy';
import { UltimateError } from './errors';
import { isJsonObject } from './json-object';

/** Set to `1` on a response whose body is a `RecordEnvelope` rather than the bare output. */
export const RECORDS_HEADER = 'x-ultimate-records';

/** One record type's rows, keyed by record key — the browser cannot derive a key without the entity. */
export type RecordRows = Readonly<Record<string, Row>>;

export interface RecordEnvelope<T = unknown> {
  readonly data: T;
  /** Rows to adopt: record type -> record key -> row. */
  readonly records?: Readonly<Record<string, RecordRows>>;
  /** Record keys to drop, keyed by the entity's record type. */
  readonly removed?: Readonly<Record<string, readonly string[]>>;
}

/** The server half. An empty `removed` is omitted, so the envelope never claims a deletion. */
export function encodeRecordEnvelope<T>(
  data: T,
  records: Readonly<Record<string, RecordRows>>,
  removed?: Readonly<Record<string, readonly string[]>>,
): RecordEnvelope<T> {
  const hasRemoved = removed !== undefined && Object.keys(removed).length > 0;
  return hasRemoved ? { data, records, removed } : { data, records };
}

/**
 * The client half: a parsed body, checked for shape and copied onto null-prototype maps — a
 * record type and a record key are server data, and `JSON.parse` mints `__proto__` as a real own
 * key, which assigned onto a plain object would replace its prototype.
 */
export function decodeRecordEnvelope(body: unknown): RecordEnvelope {
  if (!isJsonObject(body) || !Object.hasOwn(body, 'data')) {
    throw envelopeInvalid('the body', 'is not an object with an own "data" member');
  }
  const records = byType(body['records'], 'records', (rows, at) => {
    if (!isJsonObject(rows)) throw envelopeInvalid(at, 'is not an object of rows by key');
    return nullProto(
      Object.entries(rows).map(([key, row], index): [string, Row] => {
        if (!isJsonObject(row)) throw envelopeInvalid(`${at} row #${index}`, 'is not an object');
        return [key, row];
      }),
    );
  });
  const removed = byType(body['removed'], 'removed', (keys, at) => {
    if (!Array.isArray(keys)) throw envelopeInvalid(at, 'is not an array');
    const list: unknown[] = keys;
    const bad = list.findIndex((key) => typeof key !== 'string');
    if (bad !== -1) throw envelopeInvalid(`${at} key #${bad}`, 'is not a string');
    return list as string[];
  });
  return {
    data: body['data'],
    ...(records === undefined ? {} : { records }),
    ...(removed === undefined ? {} : { removed }),
  };
}

function byType<T>(
  value: unknown,
  member: string,
  read: (group: unknown, at: string) => T,
): Readonly<Record<string, T>> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw envelopeInvalid(`"${member}"`, 'is not an object');
  return nullProto(
    Object.entries(value).map(([type, group], index): [string, T] => [
      type,
      read(group, `"${member}" entry #${index}`),
    ]),
  );
}

function nullProto<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true });
  }
  return out;
}

/** Positions only, never the value: the body is whatever answered, and may carry anything. */
function envelopeInvalid(where: string, what: string): UltimateError {
  return new UltimateError({
    code: 'X_CLIENT_RECORD_ENVELOPE_INVALID',
    cause: `a response marked ${RECORDS_HEADER}: 1 carried a body where ${where} ${what}`,
    fix: 'build the body with encodeRecordEnvelope() from @ultimat3/core in the handler that set the header, or stop setting the header',
  });
}
