/**
 * What an island may close over: nothing but declared, JSON-safe, budgeted props.
 * An island is named by specifier, so it cannot capture a scope — the only way the server
 * reaches the browser is this bag, and every rule here is about what must not travel.
 */

import { IslandPropsInvalidError } from './errors';
import type { JsxProps } from './jsx';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type IslandProps = Readonly<Record<string, JsonValue>>;

/**
 * Props ship inside the HTML of every response, so they are page weight the `budget` never sees
 * as JS. A cap turns "I passed the whole row" into a number and a fix instead of a slow page.
 */
export const ISLAND_PROPS_MAX_BYTES = 4096;

/** JSX keys that are markup, not data: they stay on the server and never serialize. */
const SERVER_ONLY_KEYS = new Set(['children']);

/**
 * Names the value the way an author can act on it. `[object Object]` is not an instruction;
 * "a Date at props.at" is.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'bigint') return 'a bigint';
  if (typeof value === 'symbol') return 'a symbol';
  if (value instanceof Date) return 'a Date';
  if (value instanceof Map || value instanceof Set) return `a ${value.constructor.name}`;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return `an instance of ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'a class'}`;
    }
  }
  return `a ${typeof value}`;
}

/**
 * A structural walk rather than a `JSON.stringify` round-trip: stringify drops a function and a
 * `undefined` silently, which is the exact footgun — the prop the author meant to pass arrives
 * missing in the browser and the island renders an empty state nobody can reproduce on the server.
 */
function assertJsonSafe(value: unknown, path: string, seen: Set<object>, file: string): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (Array.isArray(value)) {
    guardCycle(value, path, seen, file);
    const out = value.map((item, index) => assertJsonSafe(item, `${path}[${index}]`, seen, file));
    seen.delete(value);
    return out;
  }

  if (isPlainObject(value)) {
    guardCycle(value, path, seen, file);
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      put(out, key, assertJsonSafe(item, `${path}.${key}`, seen, file));
    }
    seen.delete(value);
    return out;
  }

  throw new IslandPropsInvalidError(
    `${path} is ${describeValue(value)}, which cannot cross the server/client boundary — ` +
      'an island receives JSON and nothing else',
    `pass a plain JSON value at ${path} in ${file} (an id, not the row; a string, not a Date), ` +
      'or fetch it inside the island',
  );
}

/**
 * One walked value onto the bag. `out[key] = value` is not an assignment for exactly one name:
 * `__proto__` runs `Object.prototype`'s setter and REPLACES the prototype instead of adding a key,
 * so the prop never reaches the browser — the exact footgun the walk above exists to prevent — and
 * the record the server keeps reading answers whatever the request body chose. `JSON.parse` mints a
 * real own `__proto__` key, so a row off the wire is enough. Same shape as `validate-args.ts`'s
 * `put` in `@ultimat3/mcp`; `defineProperty` writes a plain own data property whatever the name is.
 */
function put(out: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function guardCycle(value: object, path: string, seen: Set<object>, file: string): void {
  if (!seen.has(value)) {
    seen.add(value);
    return;
  }
  throw new IslandPropsInvalidError(
    `${path} closes a cycle, so it can never be serialized for the browser`,
    `break the cycle at ${path} in ${file} — pass ids instead of linked objects`,
  );
}

/**
 * The one gate between a page's scope and an island's props. Undeclared keys are refused by
 * name because `<Modal {…row} />` is how a password hash reaches the browser, and the error that
 * lists the columns is the one that stops it.
 */
export function checkIslandProps(
  props: JsxProps,
  declared: readonly string[],
  file: string,
  moduleId: string,
): IslandProps {
  const allowed = new Set(declared);
  const passed = Object.keys(props).filter((key) => !SERVER_ONLY_KEYS.has(key));
  const undeclared = passed.filter((key) => !allowed.has(key));

  if (undeclared.length > 0) {
    throw new IslandPropsInvalidError(
      `${file} passes ${undeclared.map((key) => `\`${key}\``).join(', ')} to the ${moduleId} ` +
        `island, which declares ${declared.length === 0 ? 'no props' : declared.join(', ')} — ` +
        'an island receives exactly what it declared, so a spread row cannot leak a column',
      `add ${undeclared.map((key) => `'${key}'`).join(', ')} to props: [] on the island() call, ` +
        `or stop passing ${undeclared.length === 1 ? 'it' : 'them'} in ${file}`,
    );
  }

  const bag: Record<string, JsonValue> = {};
  const seen = new Set<object>();
  for (const key of passed) {
    put(bag, key, assertJsonSafe(props[key], `props.${key}`, seen, file));
  }

  const bytes = new TextEncoder().encode(JSON.stringify(bag)).byteLength;
  if (bytes > ISLAND_PROPS_MAX_BYTES) {
    throw new IslandPropsInvalidError(
      `the ${moduleId} island in ${file} carries ${bytes} bytes of props (cap ` +
        `${ISLAND_PROPS_MAX_BYTES}), and every one of them ships inside the HTML on every request`,
      `pass an id in ${file} and fetch the rest inside the island, or raise the cap deliberately ` +
        'by splitting the island',
    );
  }

  return bag;
}
