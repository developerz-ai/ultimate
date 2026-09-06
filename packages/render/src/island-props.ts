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
 *
 * What the cap protects. `hydrateRuntime` inlines the bag VERBATIM as
 * `<script type="application/json" data-x-props>` in the document, and `measureDocumentJs` counts
 * a JSON-typed script as data — zero JS — so `budget.js` never sees a byte of it. This constant is
 * the only ceiling on that channel. Every byte of it is parsed before first paint, on every
 * request, on every page that renders the island, and cannot be cached apart from the page.
 *
 * Why 16 KiB and not 4. It was 4096 until 2026-09-05, and a page carrying a 34-row catalog
 * (8,812 B) answered 500 at RUNTIME — a legitimate medium-sized bag, a page down. What 16 KiB
 * costs, measured against the budgets the route table derives (`DEFAULT_ISLAND_JS_BYTES`:
 * `site/` 20 KiB, `app/` 34 KiB of JS): the ceiling is a bag comparable in size to the island's
 * OWN code, and never more than it. On the wire, JSON with repeated keys gzips 4-6x, so a full
 * bag is ~3-4 KiB compressed — under 100 ms on a 3G-class link (~50 KB/s), ~1 ms of `JSON.parse`
 * on a phone. Uncompressed (a dev server, a proxy that skips `text/html`) it is ~320 ms on that
 * link, which is why the ceiling stays a ceiling and not a warning.
 *
 * Why a catalog is still the wrong thing to inline, even under the cap. A list that is the same
 * on every request is a DATASET, not a prop: behind a query route it is one `GET`, cached by the
 * browser and by the CDN, fetched once per session instead of rendered into every page. The prop
 * is the id, the initial count, the endpoint — what the island needs to draw its first frame.
 * `README.md` ("large data rides over a query endpoint") is the pattern, and the `fix:` below
 * names it.
 */
export const ISLAND_PROPS_MAX_BYTES = 16_384;

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

  const bytes = utf8Bytes(JSON.stringify(bag));
  if (bytes > ISLAND_PROPS_MAX_BYTES) {
    const heaviest = propBytes(bag).slice(0, HEAVIEST_NAMED);
    const first = heaviest[0]?.[0] ?? 'rows';
    throw new IslandPropsInvalidError(
      `the ${moduleId} island in ${file} carries ${bytes} B of props (cap ${ISLAND_PROPS_MAX_BYTES} B), ` +
        'and every one of them ships inside the HTML on every request — ' +
        heaviest.map(([key, size]) => `props.${key} is ${size} B of the ${bytes}`).join(', '),
      `in ${file}, pass ${heaviest.map(([key]) => `\`${key}: []\``).join(' and ')} beside ` +
        `\`${first}Endpoint: derivePath('<queryName>')\` (@ultimat3/query) and fetch the rows inside ` +
        'the island after mount — a list that is the same on every request is a dataset, not a ' +
        'prop; an id, a count and a URL are',
    );
  }

  return bag;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * Which keys carry the weight, heaviest first — so the finding names the prop to move, not the
 * bag. A page with `models` at 8,812 B beside `hostId` at 12 B gets one instruction, and the
 * instruction names `models`. Per-key bytes are the value's serialisation plus its `"key":`.
 */
function propBytes(bag: Record<string, JsonValue>): readonly (readonly [string, number])[] {
  return Object.entries(bag)
    .map(([key, value]): readonly [string, number] => [
      key,
      utf8Bytes(JSON.stringify(key)) + 1 + utf8Bytes(JSON.stringify(value)),
    ])
    .sort((a, b) => b[1] - a[1]);
}

/** At most two: one prop is the usual answer, two names a split, and a third is the whole bag. */
const HEAVIEST_NAMED = 2;
