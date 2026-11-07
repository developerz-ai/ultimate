// Single responsibility: the CBOR subset WebAuthn sends (RFC 8949, CTAP2 canonical form) —
// definite-length integers, byte and text strings, arrays, maps and the three simple values —
// decoded from attacker-supplied bytes. Anything else (tags, floats, indefinite lengths) is a
// refusal, never a guess: the attestation object and the COSE key use none of it.

/** A decoded item. Maps are a `Map`, never a record indexed by a key the sender chose. */
export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | ReadonlyMap<number | string, CborValue>;

/** What one item decoded to, and the offset of the first byte after it. */
export interface CborItem {
  readonly value: CborValue;
  readonly end: number;
}

/** A nested key inside a COSE key is depth 2; anything near this is not WebAuthn. */
const MAX_DEPTH = 8;
/** Items in one array or map. A COSE key has five; an attestation object three. */
const MAX_ITEMS = 64;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** `null` for every way the bytes are not one well-formed item of the subset. */
export function decodeCborItem(bytes: Uint8Array, start = 0): CborItem | null {
  try {
    return item(bytes, start, 0);
  } catch {
    // Only `TextDecoder`'s fatal throw reaches here: invalid UTF-8 in a text string.
    return null;
  }
}

/** The whole buffer as exactly one item — trailing bytes are a refusal. */
export function decodeCbor(bytes: Uint8Array): CborValue | undefined {
  const decoded = decodeCborItem(bytes);
  return decoded !== null && decoded.end === bytes.length ? decoded.value : undefined;
}

interface Head {
  readonly major: number;
  readonly argument: number;
  readonly next: number;
}

function head(bytes: Uint8Array, at: number): Head | null {
  const initial = bytes[at];
  if (initial === undefined) return null;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, argument: info, next: at + 1 };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  // 28-30 are reserved, 31 is indefinite length: neither is in the subset.
  if (width === 0 || at + 1 + width > bytes.length) return null;
  let argument = 0;
  for (let index = 1; index <= width; index += 1) {
    argument = argument * 256 + (bytes[at + index] ?? 0);
  }
  if (!Number.isSafeInteger(argument)) return null;
  return { major, argument, next: at + 1 + width };
}

function item(bytes: Uint8Array, at: number, depth: number): CborItem | null {
  if (depth > MAX_DEPTH) return null;
  const parsed = head(bytes, at);
  if (parsed === null) return null;
  const { major, argument, next } = parsed;
  switch (major) {
    case 0:
      return { value: argument, end: next };
    case 1:
      return { value: -1 - argument, end: next };
    case 2:
    case 3: {
      const end = next + argument;
      if (end > bytes.length) return null;
      const slice = bytes.slice(next, end);
      return { value: major === 2 ? slice : decoder.decode(slice), end };
    }
    case 4:
      return list(bytes, next, argument, depth);
    case 5:
      return map(bytes, next, argument, depth);
    case 7:
      if (argument === 20) return { value: false, end: next };
      if (argument === 21) return { value: true, end: next };
      if (argument === 22) return { value: null, end: next };
      return null;
    default:
      return null;
  }
}

function list(bytes: Uint8Array, at: number, count: number, depth: number): CborItem | null {
  if (count > MAX_ITEMS) return null;
  const values: CborValue[] = [];
  let cursor = at;
  for (let index = 0; index < count; index += 1) {
    const entry = item(bytes, cursor, depth + 1);
    if (entry === null) return null;
    values.push(entry.value);
    cursor = entry.end;
  }
  return { value: values, end: cursor };
}

function map(bytes: Uint8Array, at: number, count: number, depth: number): CborItem | null {
  if (count > MAX_ITEMS) return null;
  const entries = new Map<number | string, CborValue>();
  let cursor = at;
  for (let index = 0; index < count; index += 1) {
    const key = item(bytes, cursor, depth + 1);
    if (key === null || (typeof key.value !== 'number' && typeof key.value !== 'string')) {
      return null;
    }
    // A repeated key is how two parsers disagree about one object: refused, never last-wins.
    if (entries.has(key.value)) return null;
    const entry = item(bytes, key.end, depth + 1);
    if (entry === null) return null;
    entries.set(key.value, entry.value);
    cursor = entry.end;
  }
  return { value: entries, end: cursor };
}
