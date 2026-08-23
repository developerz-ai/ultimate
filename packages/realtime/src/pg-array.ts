// The Postgres array TEXT literal — `{a,b}`, `{"a,b",NULL}`, `{{1,2},{3,4}}` — and the element
// type behind an array oid. Split from `pg-values.ts` so that file stays the oid switch and this
// one stays the grammar; the element decoder arrives as a parameter, so neither imports the other.
//
// It exists because `@ultimat3/entity`'s repository hands an `arrayOf()` column back as a JS array
// (the driver parses the literal) while the WAL carries the literal itself. A live row and a
// repository row have to be the same object, so the literal is parsed here rather than shipped.

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

/** Where the scan is, so every branch below advances one cursor rather than slicing the text. */
interface Scan {
  readonly text: string;
  at: number;
}

/**
 * One array literal -> a nested JS array, or `null` when the text is not one this grammar
 * describes. `null` is not an error: a dimension prefix (`[0:2]={…}`), a `DateStyle` this decoder
 * does not read, or a corrupted literal all mean the same thing to the caller — keep the text it
 * arrived as rather than deliver an array that is missing a member.
 *
 * `decode` is the ELEMENT decoder. It never sees a quoted element's quotes or its backslash
 * escapes: an unquoted `NULL` is the null value and a quoted `"NULL"` is the four-character
 * string, which is the one distinction the quoting exists to carry.
 */
export function parsePgArray<T>(text: string, decode: (raw: string) => T): PgArray<T> | null {
  const scan: Scan = { text, at: 0 };
  const parsed = readArray(scan, decode);
  // Trailing content means the literal was not what this grammar accepted, whatever it parsed.
  return parsed === null || scan.at !== text.length ? null : parsed;
}

/** A member is a decoded value, the null member, or — for a multidimensional array — a row of them. */
export type PgArray<T> = (T | null | PgArray<T>)[];

function readArray<T>(scan: Scan, decode: (raw: string) => T): PgArray<T> | null {
  if (scan.text[scan.at] !== '{') return null;
  scan.at += 1;
  const out: PgArray<T> = [];
  if (scan.text[scan.at] === '}') {
    scan.at += 1;
    return out;
  }
  for (;;) {
    const member = readMember(scan, decode);
    if (member === FAILED) return null;
    out.push(member);
    const next = scan.text[scan.at];
    scan.at += 1;
    if (next === '}') return out;
    if (next !== ',') return null;
  }
}

/** A sentinel, because `null` is a legal member and `undefined` would be a second spelling of it. */
const FAILED = Symbol('pg-array-failed');

function readMember<T>(
  scan: Scan,
  decode: (raw: string) => T,
): T | null | PgArray<T> | typeof FAILED {
  const head = scan.text[scan.at];
  if (head === '{') {
    const nested = readArray(scan, decode);
    return nested === null ? FAILED : nested;
  }
  if (head === '"') {
    const quoted = readQuoted(scan);
    return quoted === null ? FAILED : decode(quoted);
  }
  const start = scan.at;
  while (scan.at < scan.text.length) {
    const char = scan.text[scan.at];
    if (char === ',' || char === '}') break;
    // A brace or a quote inside a bare element is a literal this grammar does not describe.
    if (char === '{' || char === '"') return FAILED;
    scan.at += 1;
  }
  if (scan.at === scan.text.length) return FAILED;
  const raw = scan.text.slice(start, scan.at);
  // Unquoted and case-insensitive is the ONLY spelling of the null member; `"NULL"` is a string.
  return raw.toUpperCase() === 'NULL' ? null : decode(raw);
}

/** The text between one pair of quotes, with `\\` and `\"` unescaped. `null` if it never closes. */
function readQuoted(scan: Scan): string | null {
  scan.at += 1;
  let out = '';
  while (scan.at < scan.text.length) {
    const char = scan.text[scan.at];
    if (char === '"') {
      scan.at += 1;
      return out;
    }
    if (char === '\\') {
      const escaped = scan.text[scan.at + 1];
      if (escaped === undefined) return null;
      out += escaped;
      scan.at += 2;
      continue;
    }
    out += char ?? '';
    scan.at += 1;
  }
  return null;
}
