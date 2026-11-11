// What a held value costs the request memo, from a bounded SAMPLE: `estimateBytes` serialises the
// whole value (160 µs for a 50-row page, measured), and the memo charges every query read. Shaped
// like the JSON `estimateBytes` would count, so both budgets read in one unit, within 2x.

/** Elements read from an array, a Map or a Set; the rest are charged at the sample's mean. */
const SAMPLE = 8;
/** Members of one object read before the rest are counted (keys only) and charged at the mean. */
const MEMBERS = 32;
/** Nesting walked; below it — and past the budget — a node is charged a flat `OPAQUE`. */
const MAX_DEPTH = 6;
const OPAQUE = 64;
/** Nodes visited per call, whatever the value's size: the work bound the memo depends on. */
const BUDGET = 512;

interface Walk {
  left: number;
}

/**
 * Cheap, bounded size estimate for an in-memory value. Never serialises, never throws: a getter or
 * a Proxy trap that throws charges its node `OPAQUE` — the charge runs inside a promise's `.then`,
 * where a throw is an unhandled rejection and a process exit.
 */
export function approxBytes(value: unknown): number {
  return sized(value, 0, { left: BUDGET });
}

function sized(value: unknown, depth: number, walk: Walk): number {
  switch (typeof value) {
    case 'string':
      return value.length + 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 5;
    case 'object':
      break;
    default:
      return 0; // undefined, a function, a symbol: JSON drops them
  }
  if (value === null) return 4;
  if (depth >= MAX_DEPTH || walk.left <= 0) return OPAQUE;
  walk.left -= 1;
  try {
    return nodeBytes(value, depth, walk);
  } catch {
    return OPAQUE;
  }
}

/** One non-null object; may throw (a getter, a Proxy trap) — `sized` catches. */
function nodeBytes(value: object, depth: number, walk: Walk): number {
  if (value instanceof Date) return 26;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return arrayBytes(value, depth, walk);
  if (value instanceof Map || value instanceof Set) return iterableBytes(value, depth, walk);
  return objectBytes(value, depth, walk);
}

/** Up to `SAMPLE` elements, evenly spread, so a page sorted by size is not read from one end. */
function arrayBytes(items: readonly unknown[], depth: number, walk: Walk): number {
  const count = items.length;
  if (count === 0) return 2;
  const taken = Math.min(count, SAMPLE);
  let sum = 0;
  for (let i = 0; i < taken; i += 1) {
    sum += sized(items[Math.floor((i * count) / taken)], depth + 1, walk) + 1;
  }
  return 2 + Math.round((sum / taken) * count);
}

/** A Map's entries or a Set's members, as `estimateBytes` walks them: the first `SAMPLE`. */
function iterableBytes(
  collection: ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>,
  depth: number,
  walk: Walk,
): number {
  const count = collection.size;
  if (count === 0) return 2;
  let sum = 0;
  let taken = 0;
  for (const item of collection.entries()) {
    if (taken === SAMPLE) break;
    const [key, member] = item;
    sum += (collection instanceof Map ? sized(key, depth + 1, walk) + 4 : 0) + 1;
    sum += sized(member, depth + 1, walk);
    taken += 1;
  }
  return 2 + Math.round((sum / taken) * count);
}

function objectBytes(record: object, depth: number, walk: Walk): number {
  let sum = 0;
  let read = 0;
  let count = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    count += 1;
    if (read === MEMBERS) continue;
    sum += key.length + 4 + sized((record as Record<string, unknown>)[key], depth + 1, walk);
    read += 1;
  }
  return count === 0 ? 2 : 2 + Math.round((sum / read) * count);
}
