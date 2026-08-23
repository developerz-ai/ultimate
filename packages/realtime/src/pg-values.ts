// One physical Postgres value, off the WAL as text, becomes the value a ROW holds — the same one
// `@ultimat3/entity`'s repository produces for that column. Lifted out of `pgoutput.ts` so that
// file stays message framing and this one stays the type catalogue.
//
// The rule it enforces is `CLAUDE.md`'s: **a live row must equal a repository row.** The WAL is
// text and a repository row is not, so `timestamp()` is a `Date` on both sides, `arrayOf()` is a
// JS array on both sides and `bytes()` is a `Uint8Array` on both sides. Left as postgres' own
// text, `compareValues(new Date(…), '2026-08-09 12:00:00+00')` fell to `String(left) < String(right)`
// — `"1786…"` against `"2026-…"` — so one edit to one column moved every row of an
// `orderBy('createdAt','desc')` feed to the top for every subscriber, and `post.tags.map(…)` threw
// in the component the first patch reached.

import { renderThrowable } from '@ultimat3/core';
import { ReplicationProtocolError } from './errors';
import type { JsonValue } from './json';
import { arrayElementOid, parsePgArray } from './pg-array';

/**
 * What a row value can be between the WAL and the wire: JSON, plus the two JS shapes a repository
 * row already carries. `Date` and `Uint8Array` are not `JsonValue` and are not meant to be — they
 * are what `JSON.stringify` turns into the string a SNAPSHOT frame carries, which is precisely the
 * format a patch frame has to converge on.
 */
export type PhysicalValue =
  | JsonValue
  | Date
  | Uint8Array
  | PhysicalValue[]
  | { [key: string]: PhysicalValue };

export type PhysicalRow = { [key: string]: PhysicalValue };

/**
 * `2026-08-09 12:00:00.123456+00` -> the ISO-8601 form `new Date` is specified to accept.
 *
 * Postgres writes a space between the date and the clock, an offset that may be `+00`, `+0530` or
 * `+05:30`, and as many fractional digits as the column's precision. `Date` holds milliseconds, so
 * the fraction is TRUNCATED to three — which is what the driver does on the repository side, so
 * both readers of one column land on the same instant.
 */
const TIMESTAMP =
  /^(\d{4,6})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * `undefined` for a text this decoder does not describe — `infinity`, a BC date, a non-ISO
 * `DateStyle` — and the caller keeps the text it arrived as. Silence beats a wrong instant: the
 * value still crosses, it simply does not claim to be a `Date`.
 *
 * The `DateStyle` half is closed at the SESSION and not here: `pg-connection.ts` pins
 * `datestyle=ISO` in the startup packet, so a server configured `SQL`, `German` or `Postgres`
 * cannot quietly send this branch every timestamp it decodes. Nothing in this file may depend on
 * that — a text it cannot read still keeps its text — but a reader wondering why the ISO
 * assumption is safe should look there rather than rediscover it.
 *
 * A `timestamp without time zone` (oid 1114) carries no offset and is read as UTC. This framework's
 * `timestamp()` is always `timestamptz`, so the only way to reach that branch is an adopted table —
 * and UTC is the one reading with no ambient zone in it.
 */
function toInstant(text: string): Date | undefined {
  const parts = TIMESTAMP.exec(text);
  if (parts === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, zone] = parts;
  const millis = fraction === undefined ? '000' : `${fraction.slice(1)}000`.slice(0, 3);
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offsetOf(zone)}`,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** `+05` and `+0530` are offsets postgres writes and `Date` does not read; `±HH:MM` is both. */
function offsetOf(zone: string | undefined): string {
  if (zone === undefined || zone === 'Z') return 'Z';
  if (zone.length === 3) return `${zone}:00`;
  if (zone.length === 5) return `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return zone;
}

const HEX = /^[0-9a-fA-F]*$/;

/**
 * `\x0102` -> `Uint8Array([1, 2])`, the value `bytes()` parses to on the repository side.
 *
 * `undefined` for anything else, including the pre-9.0 `escape` output format: that one is
 * ambiguous without knowing the server's `bytea_output`, and a wrong byte string is worse than the
 * text. Nothing this framework creates sets it.
 */
function toBytes(text: string): Uint8Array | undefined {
  if (!text.startsWith('\\x')) return undefined;
  const hex = text.slice(2);
  if (hex.length % 2 !== 0 || !HEX.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Postgres sends every value as text (we never negotiate binary). Decoding depends on the
 * column's type oid — the wire gives us nothing else to go on, so this switch is the one place
 * that type catalogue is encoded.
 */
export function decodeValue(typeOid: number, text: string): PhysicalValue {
  switch (typeOid) {
    case 16: // bool
      return text === 't';

    case 20: {
      // int8: only safe as a number if it round-trips exactly; otherwise keep the digits —
      // a rounded bigint is a worse lie than a string that still parses correctly downstream.
      const asNumber = Number(text);
      return Number.isSafeInteger(asNumber) ? asNumber : text;
    }

    case 21: // int2
    case 23: // int4
    case 26: // oid
      return Number(text);

    case 700: // float4
    case 701: // float8
      // JSON has no literal for these three, so the text form survives the round trip instead of
      // silently becoming a number `JSON.stringify` would otherwise turn into `null`.
      if (text === 'NaN' || text === 'Infinity' || text === '-Infinity') return text;
      return Number(text);

    case 1700: // numeric — exactness beats convenience; money is never a float here.
      return text;

    case 114: // json
    case 3802: {
      // jsonb
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new ReplicationProtocolError({
          stage: 'value',
          detail: `type oid ${typeOid} carried invalid json: ${renderThrowable(cause)}`,
        });
      }
      return parsed as JsonValue;
    }

    case 1114: // timestamp
    case 1184: // timestamptz
      // A `Date`, because `timestamp()` reads back as one through the repository and the two have
      // to be one value: `JSON.stringify` gives the wire the same ISO string either way.
      return toInstant(text) ?? text;

    case 1082: // date
      // Already the value: `date()` parses to `@ultimat3/time`'s `PlainDate`, which IS the
      // `YYYY-MM-DD` string postgres wrote. Converting it to a `Date` would be the 100x-style
      // reinterpretation the calendar/instant split exists to prevent.
      return text;

    case 17: // bytea
      return toBytes(text) ?? text;

    default: {
      // An array type's element is the only thing left that changes the answer, and only when this
      // decoder knows which element type it is — see `pg-array.ts` for what an unknown oid costs.
      const element = arrayElementOid(typeOid);
      if (element === undefined) return text; // text, varchar, uuid, enum, and everything else.
      return parsePgArray(text, (raw) => decodeValue(element, raw)) ?? text;
    }
  }
}
