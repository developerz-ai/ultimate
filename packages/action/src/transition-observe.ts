/**
 * What a `transition()`'s policy READ off the loaded row, carried from the guard to the
 * compare-and-set (#702). The loader's row reaches the rule as a recording view; the move hands the
 * raw row and the properties the rule touched to `Table.transition`, which pins them in its predicate.
 */

import type { TransitionObservation } from '@ultimat3/entity';

/**
 * Keyed by the PARSED INPUT object, which `invoke` hands to the loader and then to the handler by
 * reference — a fresh object per invocation, so two concurrent moves of one row never share an
 * entry, and a denied call's entry goes with its input. Module-private: nothing else can write one.
 */
const OBSERVED = new WeakMap<object, { readonly row: unknown; readonly read: Set<string> }>();

/**
 * The view the rule is handed: the same row, recording every property it asks about. Anything that
 * enumerates the row (a spread, `Object.keys`, a serialiser) records every key it enumerates — it
 * may have looked at all of them, so all of them are pinned. Only own string keys mean anything:
 * entity pins the ones that name a column of the moved entity and ignores the rest.
 */
const recording = (row: object, read: Set<string>): object =>
  new Proxy(row, {
    get(target, property) {
      // `then` is the promise machinery asking whether the loader's answer is a thenable — the
      // `await` in `invoke`, never the rule. The one name this view cannot attribute, so a column
      // named `then` is never pinned.
      if (typeof property === 'string' && property !== 'then') read.add(property);
      // `target` as the receiver, not the proxy: a getter on a class row runs against the object
      // that owns its private state, exactly as it would unobserved — which also means a column it
      // reads through `this` is NOT recorded, only the getter's own name. Documented on
      // `TransitionDef.row` as unpinned; a proxy receiver would throw on any `#private` access.
      return Reflect.get(target, property, target);
    },
    has(target, property) {
      if (typeof property === 'string') read.add(property);
      return Reflect.has(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === 'string') read.add(property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      for (const key of keys) if (typeof key === 'string') read.add(key);
      return keys;
    },
  });

/** Remember the loaded row for this invocation, and hand back what the rule should see. */
export function observeRow<TRow>(input: unknown, row: TRow | null): TRow | null {
  if (typeof input !== 'object' || input === null) return row;
  const read = new Set<string>();
  OBSERVED.set(input, { row, read });
  // A non-object row has nothing to read off; the rule gets it unchanged. The cast is the Proxy's
  // own: a proxy over `row` presents exactly `row`'s shape.
  return typeof row === 'object' && row !== null ? (recording(row, read) as TRow) : row;
}

/** What the rule read for this invocation, once — `undefined` when no loader ran for it. */
export function takeObservation(input: unknown): TransitionObservation | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const seen = OBSERVED.get(input);
  if (seen === undefined) return undefined;
  OBSERVED.delete(input);
  return { row: seen.row, read: [...seen.read] };
}
