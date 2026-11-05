/**
 * The pinned URLs (`http: { path, method }`) a server stamps into its document, and the browser's
 * read of them: `{"a":{"<action>":"<METHOD> <path>"},"q":{"<query>":"<path>"}}` under
 * `<meta name="ultimate-pins">`. One format, written and read here, so a by-name browser caller
 * goes where the declaration put the primitive and no browser ref restates the pin.
 */

import { CLIENT_PINS_META } from './page-meta';

export type PinnedActionMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const METHODS: readonly PinnedActionMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface ActionPin {
  readonly path: string;
  readonly method: PinnedActionMethod;
}

/** What a server pins, by registered name: an action's path and verb, a query's path. */
export interface ClientPins {
  readonly actions: Readonly<Record<string, ActionPin>>;
  readonly queries: Readonly<Record<string, string>>;
}

const sorted = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The meta's content, or `undefined` when nothing is pinned — no tag, so an app that pins nothing
 * renders the bytes it always did. Sorted, so one registry is one byte string whatever its order.
 */
export function encodeClientPins(pins: ClientPins): string | undefined {
  const actions = sorted(pins.actions);
  const queries = sorted(pins.queries);
  if (actions.length === 0 && queries.length === 0) return undefined;
  return JSON.stringify({
    ...(actions.length === 0
      ? {}
      : {
          a: Object.fromEntries(actions.map(([name, pin]) => [name, `${pin.method} ${pin.path}`])),
        }),
    ...(queries.length === 0 ? {} : { q: Object.fromEntries(queries) }),
  });
}

/** The last stamp parsed, by its content: a page asks per call, and parses once per document. */
let parsed: { readonly content: string; readonly table: unknown } | undefined;

/**
 * `table[kind][name]` of the document's stamp, or `undefined`: no document (a server, a worker),
 * no stamp (nothing pinned), or content this build cannot read. Only the server writes the tag, so
 * an unreadable one is a mismatched build — and the derived URL is the one it would have answered.
 */
function stamped(kind: 'a' | 'q', name: string): unknown {
  const doc: { querySelector?: (selector: string) => { content?: unknown } | null } | undefined =
    Reflect.get(globalThis, 'document');
  const content = doc?.querySelector?.(`meta[name="${CLIENT_PINS_META}"]`)?.content;
  if (typeof content !== 'string') return undefined;
  if (parsed?.content !== content) {
    let table: unknown;
    try {
      table = JSON.parse(content);
    } catch {
      table = undefined;
    }
    parsed = { content, table };
  }
  const section: unknown =
    typeof parsed.table === 'object' && parsed.table !== null
      ? Reflect.get(parsed.table, kind)
      : undefined;
  if (typeof section !== 'object' || section === null || !Object.hasOwn(section, name)) {
    return undefined;
  }
  return Reflect.get(section, name);
}

/** The action `name`'s pinned path and verb, as this document's server serves it. */
export function renderedActionPin(name: string): ActionPin | undefined {
  const value = stamped('a', name);
  if (typeof value !== 'string') return undefined;
  const space = value.indexOf(' ');
  const method = METHODS.find((known) => known === value.slice(0, space));
  const path = value.slice(space + 1);
  return method === undefined || !path.startsWith('/') ? undefined : { path, method };
}

/** The query `name`'s pinned path, as this document's server serves it. */
export function renderedQueryPin(name: string): string | undefined {
  const value = stamped('q', name);
  return typeof value === 'string' && value.startsWith('/') ? value : undefined;
}
