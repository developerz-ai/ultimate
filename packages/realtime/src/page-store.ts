// The page's realtime state as every island READS it: one object per tab on `globalThis` under a
// `Symbol.for` key, because every island is its own bundle and a module-scope singleton here is
// one store PER ISLAND. Thin by design — the store, the socket and the transport behind it are the
// page runtime's (`page-runtime.ts`), shipped once per page and never inside an island (#505).

import type { clientTransport } from '@ultimat3/core/page';
import { CLIENT_SCOPE_META } from '@ultimat3/core/page';
import type { queryClientMethodFor } from '@ultimat3/query/client';
import type { LiveClient } from './client';
import { RealtimeUninstalledError } from './page-errors';
import type { RecordStore } from './record-store';

/** Where the page's one socket dials. Resolved on the server and handed to the island bootstrap. */
export interface SyncTarget {
  /** `wss://…/_x/sync` (or `ws://` in dev) — the sync node's own URL. */
  readonly url: string;
  /** This build, so the node can tell a stale tab to reload rather than serve it a patch. */
  readonly buildId: string;
}

/** Page-wide and shared by every bundle. Structural on purpose: no `instanceof` across copies. */
export interface PageRealtime {
  /**
   * The page's ONE record store — `undefined` until the page runtime is installed (the page boot,
   * or the runtime chunk an island loads where no boot is rendered). A hook reads it through
   * `installedPage`, which refuses by code rather than answering a store nobody shares.
   */
  store: RecordStore | undefined;
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
  /** What a hook calls instead of bundling it — installed with the store, by the page runtime. */
  services: PageServices | undefined;
}

/**
 * The runtime's half of every hook: the work whose code would otherwise ship in each island. An
 * island calls these off the page object, so the socket stack, the query client and core's
 * transport are in the page runtime once, however many islands the page renders.
 */
export interface PageServices {
  /** The page's one socket, opened on the first ask. `hook` names the caller in a refusal. */
  socket(hook: string): LiveClient;
  /** A non-live query read over HTTP — `@ultimat3/query`'s client, through core's transport. */
  read(name: string): ReturnType<typeof queryClientMethodFor>;
  /** Core's one transport, for a write's POST. */
  send: typeof clientTransport;
}

/** The page once its runtime is installed: what every hook works against. */
export type InstalledPage = PageRealtime & {
  readonly store: RecordStore;
  readonly services: PageServices;
};

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

/**
 * Whether a deferred `<script>` of this document may still run. Not past `loading`, yes; past
 * `complete`, no. In between (`interactive`) the deferred scripts run, then DOMContentLoaded fires —
 * and `readyState` stays `interactive` until every image has loaded, so the navigation timing's
 * `domContentLoadedEventStart` is what says they have all run (a boot that 404'd among them). A
 * document with no such reading is assumed still running them: a caller then waits on DOMContentLoaded.
 */
export function deferredScriptsPending(): boolean {
  if (typeof document === 'undefined') return false;
  const state: unknown = document.readyState;
  if (state === 'complete') return false;
  if (state !== 'interactive') return true;
  const timing: unknown =
    typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function'
      ? undefined
      : performance.getEntriesByType('navigation')[0];
  const started: unknown =
    typeof timing === 'object' && timing !== null
      ? Reflect.get(timing, 'domContentLoadedEventStart')
      : undefined;
  return !(typeof started === 'number' && started > 0);
}

function bootComing(): boolean {
  if (typeof document === 'undefined' || typeof addEventListener !== 'function') return false;
  if (!deferredScriptsPending()) return false;
  // A partial `document` (a component test's stand-in) has no query surface: no tag, no boot.
  if (typeof document.querySelector !== 'function') return false;
  return document.querySelector(`meta[name="${CLIENT_SCOPE_META}"]`) !== null;
}

type Host = { [KEY]?: PageRealtime };

/**
 * Get-or-create the page object — never its runtime: an island that asks before the runtime is
 * installed (`installRealtime` seating a sync target) gets the object the runtime then fills.
 */
export function pageRealtime(): PageRealtime {
  const host = globalThis as Host;
  const existing = host[KEY];
  if (existing !== undefined) return existing;
  const created: PageRealtime = {
    store: undefined,
    sync: undefined,
    socket: undefined,
    writes: { pending: new Map(), failed: 0, listeners: new Set() },
    get booted(): Promise<void> {
      return bootedPromise();
    },
    services: undefined,
  };
  Object.defineProperty(host, KEY, { value: created, configurable: true });
  return created;
}

/** The page state when some island already made it — never creates one (a server render must not). */
export function peekPageRealtime(): PageRealtime | undefined {
  return (globalThis as Host)[KEY];
}

/**
 * The page with its runtime installed, or `X_REALTIME_UNINSTALLED` naming `hook`. An island `x
 * build` wrapped never sees the refusal — its bootstrap awaits the runtime before any hook runs.
 */
export function installedPage(hook: string): InstalledPage {
  const page = pageRealtime();
  if (page.store === undefined || page.services === undefined) {
    throw new RealtimeUninstalledError({ hook });
  }
  return page as InstalledPage;
}

/**
 * Whether this page holds a socket — `false` on a server render and before any live hook ran.
 * The guard a component with a static fallback asks (an offline banner, an update prompt). Here,
 * not beside the socket, so asking it costs an island none of the connection lifecycle.
 */
export function hasPageSocket(): boolean {
  return peekPageRealtime()?.socket !== undefined;
}

/** The page's record store, from its installed runtime. */
export function pageStore(hook = 'pageStore'): RecordStore {
  return installedPage(hook).store;
}
