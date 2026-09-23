// The page's realtime state: ONE record store and ONE sync target per tab, whichever island bundle
// asks first. On `globalThis` under a `Symbol.for` key, because every island is its own bundle and
// a module-scope singleton here is one store PER ISLAND — the bug this file exists to end.

import { CLIENT_SCOPE_META, onRescope, pageClient } from '@ultimat3/core/page';
import { RecordStore } from './record-store';

/** Where the page's one socket dials. Resolved on the server and handed to the island bootstrap. */
export interface SyncTarget {
  /** `wss://…/_x/sync` (or `ws://` in dev) — the sync node's own URL. */
  readonly url: string;
  /** This build, so the node can tell a stale tab to reload rather than serve it a patch. */
  readonly buildId: string;
}

/** Page-wide and shared by every bundle. Structural on purpose: no `instanceof` across copies. */
export interface PageRealtime {
  readonly store: RecordStore;
  sync: SyncTarget | undefined;
  /** The socket client, once a live hook opened it. Typed by `page-socket.ts`, its one writer. */
  socket: unknown;
  /** Optimistic writes in flight across the page, and the ones the server refused. */
  readonly writes: PageWrites;
  /**
   * Settles once the page's boot script (`@ultimat3/realtime/boot`) has put this principal's
   * persisted records back. The socket connects after it, so a restored row is on screen before
   * the first frame can race it. Resolved at once on a page that carries no boot script.
   */
  readonly booted: Promise<void>;
}

/** Every optimistic write on the page, counted per mutator name, and who renders the counts. */
export interface PageWrites {
  readonly pending: Map<string, number>;
  failed: number;
  readonly listeners: Set<() => void>;
}

const KEY: unique symbol = Symbol.for('ultimate.realtime');

/**
 * Where the boot script leaves its promise. The boot is ONE page-level script, not code in every
 * island: a read-only island carried the disk restore and the outbox (15.5 kB) for a job the page
 * does once. Read per access, so an island that ran first still waits on a boot that started later.
 */
export const BOOT_KEY: unique symbol = Symbol.for('ultimate.page-boot');

/**
 * Set only while an island is waiting on a boot that has not started yet: the resolver of the
 * promise already sitting under `BOOT_KEY`. The boot CLAIMS it (deletes it) and resolves it once
 * the restore is done; a page whose boot never ran has it resolved by `load` instead.
 */
export const BOOT_RELEASE_KEY: unique symbol = Symbol.for('ultimate.page-boot.release');

export type BootHost = { [BOOT_KEY]?: Promise<void>; [BOOT_RELEASE_KEY]?: () => void };

/**
 * The boot's promise, or — when an island asks FIRST on a page whose boot is still coming — a
 * promise the boot will settle. An island can hydrate before the deferred boot script has run
 * (the idle callback fires while the parser waits on that script), and answering "already booted"
 * then meant a reload offline rebuilt no overlay and replayed nothing: the write looked lost.
 * A boot is coming exactly when the document carries the scope tag (the CLI renders the boot
 * beside it) and has not finished loading; `load` settles it if the script never ran.
 */
export function bootedPromise(): Promise<void> {
  const host = globalThis as BootHost;
  const started = host[BOOT_KEY];
  if (started !== undefined) return started;
  if (!bootComing()) return Promise.resolve();
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(host, BOOT_KEY, { value: waiting, configurable: true });
  Object.defineProperty(host, BOOT_RELEASE_KEY, { value: release, configurable: true });
  addEventListener(
    'load',
    () => {
      // Still unclaimed after every deferred script ran: this page's boot is not coming.
      if (host[BOOT_RELEASE_KEY] !== release) return;
      Reflect.deleteProperty(host, BOOT_RELEASE_KEY);
      release();
    },
    { once: true },
  );
  return waiting;
}

function bootComing(): boolean {
  if (typeof document === 'undefined' || typeof addEventListener !== 'function') return false;
  if (document.readyState === 'complete') return false;
  // A partial `document` (a component test's stand-in) has no query surface: no tag, no boot.
  if (typeof document.querySelector !== 'function') return false;
  return document.querySelector(`meta[name="${CLIENT_SCOPE_META}"]`) !== null;
}

type Host = { [KEY]?: PageRealtime };

/** Get-or-create. Installs the store as core's `RecordSink`, so HTTP answers adopt into it. */
export function pageRealtime(): PageRealtime {
  const host = globalThis as Host;
  const existing = host[KEY];
  if (existing !== undefined) return existing;
  const store = new RecordStore();
  const created: PageRealtime = {
    store,
    sync: undefined,
    socket: undefined,
    writes: { pending: new Map(), failed: 0, listeners: new Set() },
    get booted(): Promise<void> {
      return bootedPromise();
    },
  };
  Object.defineProperty(host, KEY, { value: created, configurable: true });
  pageClient().store = store;
  // A new principal sees nothing of the previous one: every record goes, in memory, at once.
  onRescope(() => store.clear());
  return created;
}

/** The page state when some island already made it — never creates one (a server render must not). */
export function peekPageRealtime(): PageRealtime | undefined {
  return (globalThis as Host)[KEY];
}

/**
 * Whether this page holds a socket — `false` on a server render and before any live hook ran.
 * The guard a component with a static fallback asks (an offline banner, an update prompt). Here,
 * not beside the socket, so asking it costs an island none of the connection lifecycle.
 */
export function hasPageSocket(): boolean {
  return peekPageRealtime()?.socket !== undefined;
}

/** The page's record store. */
export function pageStore(): RecordStore {
  return pageRealtime().store;
}
