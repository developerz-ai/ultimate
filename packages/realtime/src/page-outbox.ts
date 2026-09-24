/**
 * The page's ONE outbox: writes a page could not send are queued in `OfflineQueue`, persisted in
 * the page's durable store under the current principal, and replayed IN ORDER over HTTP — each to
 * `actionPath(name)` through core's `clientTransport`, each with its own idempotency key, so a
 * replay after a lost response is answered from the action's idempotency store and never applied
 * twice. Replayed on open, on `online`, and on the service worker's `OUTBOX_DRAIN_MESSAGE`.
 * A principal change wipes the previous principal's queue: its writes are never sent as the next.
 */

import type { ClientScope } from '@ultimat3/core/page';
import {
  actionPath,
  classifyThrown,
  clientTransport,
  OUTBOX_DRAIN_MESSAGE,
  onRescope,
  pageClient,
} from '@ultimat3/core/page';
import type { LocalStore } from './local-store-idb';
import { pageLocalStore, scopeKey } from './local-store-idb';
import type { DrainReport, QueuedMutation, QueueState, QueueStore } from './offline-queue';
import { MemoryQueueStore, OfflineQueue, toQueueError } from './offline-queue';
import { OUTBOX_KEY, type OutboxEntry, type OutboxHandle, type OutboxHost } from './outbox-slot';
import { peekPageRealtime } from './page-store';
import { carriedBy } from './record-store';

export type { OutboxEntry } from './outbox-slot';

export interface PageOutbox extends OutboxHandle {
  enqueue(entry: OutboxEntry): Promise<void>;
  /** Sends everything queued, in order, stopping at the first write the network could not take. */
  replay(): Promise<DrainReport>;
  /** Writes not yet taken by the server. `0` until the store has opened. */
  readonly size: number;
  /**
   * Those writes, in queue order — what `useMutation` re-applies as overlays after a reload, so a
   * queued write is ON SCREEN until its replay settles or refuses it. Empty until `ready`.
   */
  pending(): readonly OutboxEntry[];
  /** Settles once the current principal's queue is open. */
  readonly ready: Promise<void>;
}

/** The optimistic twins a replay settles or takes back — the page's record store. */
export interface OutboxOverlays {
  settle(key: string, carried?: ReadonlySet<string>): void;
  drop(key: string): void;
}

export interface OutboxOptions {
  readonly local: LocalStore | Promise<LocalStore>;
  readonly principal?: (() => ClientScope['principal']) | undefined;
  /**
   * One write, over HTTP. Default: `clientTransport` POST to `actionPath(entry.name)`, adding every
   * record the answer carried (`type:key`) to `carried` — what its overlay settles against.
   */
  readonly send?: ((entry: OutboxEntry, carried: Set<string>) => Promise<unknown>) | undefined;
  readonly overlays?: (() => OutboxOverlays | undefined) | undefined;
  /**
   * Runs, and is awaited, before a write is queued. The boot hands it the record persister's
   * `flush`: a queued write is replayed over the rows it touched, so those rows reach the disk no
   * later than the write does — measured, a reload inside the persister's debounce came back with
   * the write queued and the post it liked missing, and showed the old count.
   */
  readonly beforeEnqueue?: (() => Promise<void>) | undefined;
}

const EMPTY: DrainReport = { sent: 0, collapsed: 0, remaining: 0, stoppedAt: null };

export function createOutbox(options: OutboxOptions): PageOutbox {
  const principal =
    options.principal ?? ((): ClientScope['principal'] => pageClient().scope.principal);
  const send = options.send ?? sendOverHttp;
  const overlays =
    options.overlays ?? ((): OutboxOverlays | undefined => peekPageRealtime()?.store);
  let queue: OfflineQueue | undefined;
  /** The scope the open queue belongs to — what the drain lock is named after. */
  let scope: string | undefined;

  const open = async (): Promise<void> => {
    scope = scopeKey(principal());
    queue = await OfflineQueue.open(queueStore(await options.local, scope));
  };
  let ready = open();
  let running: Promise<DrainReport> | undefined;
  /** A trigger landed while a pass ran: one more pass follows it, never one per trigger. */
  let again = false;

  const deliver = async (mutation: QueuedMutation): Promise<void> => {
    const current = queue;
    const carried = new Set<string>();
    try {
      await send({ key: mutation.key, name: mutation.name, input: mutation.input }, carried);
    } catch (error) {
      const kind = classifyThrown(error);
      // The network, or a server asking to be asked again: stays queued, and the pass stops so
      // nothing behind it overtakes it.
      if (kind === 'retryable' || kind === 'retry-after') throw error;
      // Anything else is the server's decision about this write — kept for the UI, never resent.
      await current?.fail(mutation.key, toQueueError(error));
      overlays()?.drop(mutation.key);
      return;
    }
    await current?.ack(mutation.key);
    const store = overlays();
    try {
      // Exactly as a live write settles: a row the answer did not carry keeps its overlay until
      // the server's row for it arrives.
      store?.settle(mutation.key, carried);
    } catch {
      // A custom merge that answered no row: the server's truth stands.
      store?.drop(mutation.key);
    }
  };

  onRescope((_next, prev) => {
    const gone = scopeKey(prev.principal);
    ready = ready.then(async () => {
      if (gone !== undefined) await (await options.local).wipe(gone);
      await open();
    });
  });

  const self: PageOutbox = {
    enqueue: async (entry) => {
      // A disk that refused the rows must not also cost the write: the intent still goes on disk.
      await options.beforeEnqueue?.().catch(() => undefined);
      await ready;
      await queue?.enqueue(entry);
    },
    replay: () => {
      // Single flight: a trigger that lands while a replay is running JOINS it. Open, `online`,
      // the socket's reconnect and the service worker's drain arrive together, and each chaining
      // a pass of its own sent the head of the queue once per trigger whenever a send failed —
      // one write, several POSTs. What the running pass could not have seen — a write queued
      // after it re-read the store — gets exactly ONE follow-up pass, however many triggers
      // joined: `again` is a flag, never a count.
      if (running !== undefined) {
        again = true;
        return running;
      }
      const pass = (async (): Promise<DrainReport> => {
        await ready;
        if (queue === undefined) return EMPTY;
        // Checked when the pass STARTS, whoever asked (the socket's reconnect asks too): an
        // attempt the browser already knows cannot leave is a failed request on the wire and
        // nothing more. `online` asks again.
        if (knownOffline()) return { ...EMPTY, remaining: queue.pending().length };
        const draining = queue;
        // One tab drains a principal's outbox at a time, and it drains what EVERY tab queued: the
        // queue is re-read under the lock, so a write another tab made since this one opened is
        // sent too, and an `inflight` entry — which only a pass holding this lock could have put
        // on the wire, and it is over — goes back to `pending`.
        return await exclusive(`ultimate-outbox:${scope ?? 'memory'}`, async () => {
          await draining.reload();
          return await draining.drain(deliver);
        });
      })();
      const settled = (report?: DrainReport): void => {
        if (running !== pass) return;
        running = undefined;
        // Only after a pass that reached the end: one stopped by a failure leaves the rest for
        // the next trigger, as it always did.
        if (again && report !== undefined && report.stoppedAt === null) {
          again = false;
          void self.replay().catch(() => undefined);
        }
        again = false;
      };
      running = pass;
      pass.then(settled, () => settled());
      return pass;
    },
    get size(): number {
      return queue?.pending().length ?? 0;
    },
    pending: () => (queue?.pending() ?? []).map(({ key, name, input }) => ({ key, name, input })),
    get ready(): Promise<void> {
      return ready;
    },
  };
  return self;
}

/** Persisted under the principal; an UNSCOPED page queues in memory only, and loses it on reload. */
function queueStore(local: LocalStore, scope: string | undefined): QueueStore {
  if (scope === undefined) return new MemoryQueueStore();
  return {
    load: async (): Promise<QueueState> =>
      (await local.queue(scope)) ?? { mutations: [], nextSeq: 1 },
    write: (change) => local.writeQueue(scope, change),
  };
}

/** The slice of the Web Locks API a drain needs. */
interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * `work` under the browser's Web Lock named `name`, so two tabs of one user never drain one outbox
 * at once — they would each send the head of the queue. With no `navigator.locks` the same
 * exclusion is kept inside this realm, on a chain held on `globalThis` (every island bundle carries
 * its own copy of this module): tabs cannot be excluded there, but two outboxes in one page can.
 */
function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const navigator: unknown = Reflect.get(globalThis, 'navigator');
  const locks: unknown =
    typeof navigator === 'object' && navigator !== null
      ? Reflect.get(navigator, 'locks')
      : undefined;
  if (
    typeof locks === 'object' &&
    locks !== null &&
    typeof Reflect.get(locks, 'request') === 'function'
  ) {
    return (locks as LockManagerLike).request(name, work);
  }
  const host = globalThis as LockHost;
  const chains = host[LOCAL_LOCKS] ?? new Map<string, Promise<unknown>>();
  if (host[LOCAL_LOCKS] === undefined) {
    Object.defineProperty(host, LOCAL_LOCKS, { value: chains, configurable: true });
  }
  const ahead = chains.get(name) ?? Promise.resolve();
  const turn = ahead.then(work, work);
  const tail = turn.then(
    () => undefined,
    () => undefined,
  );
  chains.set(name, tail);
  void tail.then(() => {
    if (chains.get(name) === tail) chains.delete(name);
  });
  return turn;
}

const LOCAL_LOCKS: unique symbol = Symbol.for('ultimate.outbox-locks');
type LockHost = { [LOCAL_LOCKS]?: Map<string, Promise<unknown>> };
function sendOverHttp(entry: OutboxEntry, carried: Set<string>): Promise<unknown> {
  return clientTransport({
    method: 'POST',
    url: actionPath(entry.name),
    body: entry.input,
    idempotencyKey: entry.key,
    onEnvelope: (envelope) => carriedBy(envelope, carried),
  });
}

/**
 * The page's outbox, created once per tab. In a browser it replays on open, on `online`, and on the
 * service worker's drain message; with no `document` it is a memory queue that listens for nothing.
 */
export function pageOutbox(options: Pick<OutboxOptions, 'beforeEnqueue'> = {}): PageOutbox {
  const host = globalThis as OutboxHost;
  const existing = host[OUTBOX_KEY];
  // Only this function writes the slot, so what it holds is always a `PageOutbox`.
  if (existing !== undefined) return existing as PageOutbox;
  const outbox = createOutbox({ local: pageLocalStore(), beforeEnqueue: options.beforeEnqueue });
  Object.defineProperty(host, OUTBOX_KEY, { value: outbox, configurable: true });
  if (Reflect.has(globalThis, 'document')) {
    listenForDrain(outbox);
    if (!knownOffline()) void outbox.replay().catch(() => undefined);
  }
  return outbox;
}

/**
 * The two drain signals a page can receive: the service worker's `sync` (posted to every open tab
 * as `OUTBOX_DRAIN_MESSAGE`), and the browser coming back `online`. A replay that fails leaves the
 * queue as it was — the next signal tries again — so its rejection is not the listener's to raise.
 */
export function listenForDrain(outbox: Pick<PageOutbox, 'replay'>): () => void {
  const replay = (): void => {
    if (!knownOffline()) void outbox.replay().catch(() => undefined);
  };
  const worker: EventTarget | undefined = Reflect.get(
    Reflect.get(globalThis, 'navigator') ?? {},
    'serviceWorker',
  );
  const onMessage = (event: Event): void => {
    const data: unknown = Reflect.get(event, 'data');
    if (
      typeof data === 'object' &&
      data !== null &&
      Reflect.get(data, 'type') === OUTBOX_DRAIN_MESSAGE
    ) {
      replay();
    }
  };
  worker?.addEventListener('message', onMessage);
  globalThis.addEventListener('online', replay);
  return () => {
    worker?.removeEventListener('message', onMessage);
    globalThis.removeEventListener('online', replay);
  };
}

/**
 * The browser says it has no network. A replay then is an attempt that can only fail — and a
 * failed attempt is still a request on the wire: measured, a reload taken offline replayed on open,
 * that POST failed, and the real one followed on `online`, so one write went out twice. The
 * `online` event is the replay's own trigger, so nothing is lost by waiting for it. Unknown (no
 * `navigator`) is not offline.
 */
function knownOffline(): boolean {
  const navigator: unknown = Reflect.get(globalThis, 'navigator');
  return (
    typeof navigator === 'object' &&
    navigator !== null &&
    Reflect.get(navigator, 'onLine') === false
  );
}
