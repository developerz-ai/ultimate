// Single responsibility: the Postgres array TEXT literal — `{a,b}`, `{"a,b",NULL}`,
// `{{1,2},{3,4}}` — read into a JS array. The one grammar in the framework: the repository reads a
// literal a driver left unparsed (`pg-array-decode.ts`) and `@ultimat3/realtime` reads the one the
// WAL carries, and two readers of one grammar are how a quoted `"NULL"` becomes a null in one of
// them. The element decoder arrives as a parameter, so this file knows no type.
//
// The writer is `arrayLiteral` in `pg-row.ts`; `pg-array-literal.test.ts` holds the two to each
// other, so what this package writes is what it can read.

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
