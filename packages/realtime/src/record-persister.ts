/**
 * Keeps the record types an app marked `persist: true` on disk, per principal, and puts them back
 * on the next load BEFORE the socket connects. Writes are debounced and flushed when the page is
 * hidden or leaves; a restored row is stale until the server confirms it, and the first server row
 * for that key wins outright.
 *
 * Only SYNCED truth is written — never an optimistic overlay: a write the server later refuses must
 * not survive a reload as if it had landed. Its intent survives in the outbox instead.
 */

import type { ClientScope, RecordRows, Row } from '@ultimat3/core/page';
import { CLIENT_PERSIST_META, finiteCount, onRescope, pageClient } from '@ultimat3/core/page';
import type { LocalStore } from './local-store-idb';
import { scopeKey } from './local-store-idb';

/**
 * What the persister needs from the page's store. `synced` and `restore` are the two methods
 * `RecordStore` owes this module (plan 101 slice 12): the server's row without the overlay, and a
 * restore that yields to — and is replaced by — the first server row for the same key.
 */
export interface PersistableStore {
  subscribe(listener: (changed: ReadonlySet<string>) => void): () => void;
  synced(type: string, key: string): Row | undefined;
  restore(type: string, rows: RecordRows): void;
}

export interface RecordPersisterOptions {
  readonly store: PersistableStore;
  readonly local: LocalStore;
  /** The record types to keep — `persistedTypes()` in a browser. */
  readonly types: ReadonlySet<string>;
  readonly principal?: (() => ClientScope['principal']) | undefined;
  readonly debounceMs?: number | undefined;
  readonly schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  /** Subscribes to "the page is going away": `pagehide`, and `visibilitychange` to hidden. */
  readonly onLeave?: ((flush: () => void) => () => void) | undefined;
}

export interface RecordPersister {
  /** Puts this principal's rows back. Resolves with how many were restored. */
  restore(): Promise<number>;
  /** Writes everything changed since the last flush, now. */
  flush(): Promise<void>;
  stop(): void;
}

export function recordPersister(options: RecordPersisterOptions): RecordPersister {
  const principal =
    options.principal ?? ((): ClientScope['principal'] => pageClient().scope.principal);
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  // A whole number of ms, at least 1: `NaN` would arm a timer that fires at once, forever.
  const debounceMs = finiteCount('recordPersister', 'debounceMs', options.debounceMs ?? 250, 1);
  const dirty = new Set<string>();
  let cancel: (() => void) | undefined;

  const flush = async (): Promise<void> => {
    cancel?.();
    cancel = undefined;
    const scope = scopeKey(principal());
    const changed = [...dirty];
    dirty.clear();
    if (scope === undefined || changed.length === 0) return;
    const puts: { type: string; key: string; row: Row }[] = [];
    const deletes: { type: string; key: string }[] = [];
    for (const rk of changed) {
      const at = rk.indexOf(':');
      const type = rk.slice(0, at);
      const key = rk.slice(at + 1);
      const row = options.store.synced(type, key);
      if (row === undefined) deletes.push({ type, key });
      else puts.push({ type, key, row });
    }
    await options.local.write(scope, puts, deletes);
  };

  const unsubscribe = options.store.subscribe((changed) => {
    for (const rk of changed) {
      if (options.types.has(rk.slice(0, rk.indexOf(':')))) dirty.add(rk);
    }
    if (dirty.size > 0 && cancel === undefined) {
      cancel = schedule(() => void flush(), debounceMs);
    }
  });

  const restore = async (): Promise<number> => {
    const scope = scopeKey(principal());
    if (scope === undefined) return 0;
    let restored = 0;
    for (const [type, rows] of await options.local.rows(scope)) {
      if (!options.types.has(type)) continue;
      options.store.restore(type, rows);
      restored += Object.keys(rows).length;
    }
    return restored;
  };

  // A principal change: the previous principal's rows leave the disk with it, nothing it changed is
  // written under the next one, and the next one's own rows come back.
  const unscope = onRescope((_next, prev) => {
    cancel?.();
    cancel = undefined;
    dirty.clear();
    const gone = scopeKey(prev.principal);
    void (gone === undefined ? Promise.resolve() : options.local.wipe(gone)).then(restore);
  });
  const unleave = (options.onLeave ?? onPageLeave)(() => void flush());

  return {
    restore,
    flush,
    stop: (): void => {
      cancel?.();
      unsubscribe();
      unscope();
      unleave();
    },
  };
}

/** `pagehide` and a hidden `visibilitychange` — the last moments a page can still write. */
function onPageLeave(flush: () => void): () => void {
  const doc: (EventTarget & { visibilityState?: string }) | undefined = Reflect.get(
    globalThis,
    'document',
  );
  // A partial `document` (a test's stand-in) has no events to hear: nothing to subscribe to.
  if (doc === undefined || typeof doc.addEventListener !== 'function') return () => {};
  const hidden = (): void => {
    if (doc.visibilityState === 'hidden') flush();
  };
  globalThis.addEventListener('pagehide', flush);
  doc.addEventListener('visibilitychange', hidden);
  return () => {
    globalThis.removeEventListener('pagehide', flush);
    doc.removeEventListener('visibilitychange', hidden);
  };
}

/** The types the server rendered as persisted (`<meta name="ultimate-persist">`). None = none. */
export function persistedTypes(): ReadonlySet<string> {
  const doc: { querySelector?: (selector: string) => { content?: unknown } | null } | undefined =
    Reflect.get(globalThis, 'document');
  const content = doc?.querySelector?.(`meta[name="${CLIENT_PERSIST_META}"]`)?.content;
  if (typeof content !== 'string') return new Set();
  return new Set(
    content
      .split(',')
      .map((type) => type.trim())
      .filter((type) => type !== ''),
  );
}
