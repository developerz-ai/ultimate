// The element type behind an array type oid. The WAL names only the ARRAY type and carries the
// value as its TEXT literal (`{a,b}`), while `@ultimat3/entity`'s repository hands an `arrayOf()`
// column back as a JS array — and a live row and a repository row have to be the same object.
//
// The GRAMMAR of that literal is `@ultimat3/entity`'s `parsePgArray`: the repository reads the
// same text when a driver leaves an array unparsed, and one grammar has one reader. This file
// keeps the half only the WAL needs — which element decoder an oid selects.

/**
 * `text[]` -> `text`. The wire names only the ARRAY type, so the element type behind it is a
 * table — and it is a closed one: `arrayOf()` refuses `jsonb`, `bytea`, `money` and a nested array
 * at declaration, so every array a framework entity can produce has its element listed below.
 *
 * The two it refuses are listed anyway (`1001`, `3807`, `199`): an adopted table can hold them,
 * and decoding an element correctly costs nothing next to leaving the whole literal as text.
 * An oid with no row — a user-defined enum's array, whose oid is per-database — is left as text
 * rather than guessed at, which is what `undefined` means to `pg-values.ts`.
 */
const ELEMENT_OF = Object.freeze<Record<number, number>>({
  1000: 16, // bool[]
  1001: 17, // bytea[]
  1005: 21, // int2[]
  1007: 23, // int4[]
  1009: 25, // text[]
  1014: 1042, // bpchar[]
  1015: 1043, // varchar[]
  1016: 20, // int8[]
  1021: 700, // float4[]
  1022: 701, // float8[]
  1028: 26, // oid[]
  1115: 1114, // timestamp[]
  1182: 1082, // date[]
  1185: 1184, // timestamptz[]
  1231: 1700, // numeric[]
  199: 114, // json[]
  2951: 2950, // uuid[]
  3807: 3802, // jsonb[]
});

/** The element type oid behind an array type oid, or `undefined` when this table does not name it. */
export function arrayElementOid(typeOid: number): number | undefined {
  return Object.hasOwn(ELEMENT_OF, typeOid) ? ELEMENT_OF[typeOid] : undefined;
}
