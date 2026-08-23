// The rules a declared island state must satisfy, as pure functions over values. Separate from
// `island-states.ts` so the vocabulary can be read without the rules and the rules can be tested
// without building a manifest; each answers a FAULT rather than throwing, so the caller is the one
// place that decides which code the failure carries.

/** A slug: lowercase letters and digits, single dashes between them. It becomes a filename stem. */
const STATE_ID = /^[a-z\d]+(?:-[a-z\d]+)*$/;

export const isStateId = (id: string): boolean => STATE_ID.test(id);

/** The id the author probably meant — `''` when nothing survives, which the error reads as "no suggestion". */
export function slugifyStateId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * An instant with an EXPLICIT offset. `2026-01-01T00:00` parses on every runtime and means a
 * different moment in every zone, which is the defect this vocabulary exists to close: a harness
 * that pins the instant and leaves the zone ambient photographs two different pictures on two
 * machines and neither is wrong.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isPinnedInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * An IANA zone, asked of the runtime rather than of a list: `Intl` is the thing that will format
 * the date, so its answer is the only one that matters. It throws a `RangeError` on a name it does
 * not know — the one case where a `catch` is the check.
 */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `"<METHOD> <pathname>"`, matched as a prefix by the harness. A lowercase verb matches nothing. */
const STUB_MATCH = /^[A-Z]+ \/\S*$/;

export const isStubMatch = (match: string): boolean => STUB_MATCH.test(match);

export interface JsonFault {
  /** Where in the declaration the value sits — `props.user.createdAt`, `routes[0].respond.body`. */
  readonly path: string;
  /** What it is, phrased to finish "…is <reason>". */
  readonly reason: string;
}

/** `[object Date]` → `Date`. Read this way because a `constructor.name` getter can throw. */
const tagOf = (value: object): string =>
  Object.prototype.toString.call(value).slice('[object '.length, -1);

/**
 * The first value in `value` that `JSON.stringify` would not carry, or `undefined` when the whole
 * structure survives the trip. Island props ride `data-x-props`, which is JSON by construction
 * (`@ultimat3/render`'s `emitIslandProps`), so anything else is not "approximately right" in the
 * picture — it is a prop the component never receives, silently.
 *
 * Stricter than `JSON.stringify` on purpose, in the three places it degrades instead of failing:
 * `undefined` disappears, a non-finite number becomes `null`, and a `Date` becomes a string that no
 * longer answers `.getTime()`. Each is a state that photographs as a crash with nothing pointing
 * back at the declaration.
 */
export function jsonFault(
  value: unknown,
  path: string,
  seen: readonly object[] = [],
): JsonFault | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : { path, reason: 'not a finite number' };
    case 'undefined':
      return { path, reason: 'undefined, which JSON drops without a trace' };
    case 'bigint':
      return { path, reason: 'a bigint, which JSON cannot carry' };
    case 'symbol':
      return { path, reason: 'a symbol' };
    case 'function':
      return { path, reason: 'a function — a picture takes no callbacks' };
    default:
      break;
  }
  const object = value as object;
  if (seen.includes(object)) return { path, reason: 'a cycle' };
  const next = [...seen, object];
  if (Array.isArray(object)) {
    for (const [index, item] of object.entries()) {
      const fault = jsonFault(item, `${path}[${index}]`, next);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  const proto: unknown = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) {
    return { path, reason: `a ${tagOf(object)}, and only a plain object survives JSON` };
  }
  for (const [key, entry] of Object.entries(object)) {
    const fault = jsonFault(entry, `${path}.${key}`, next);
    if (fault !== undefined) return fault;
  }
  return undefined;
}
