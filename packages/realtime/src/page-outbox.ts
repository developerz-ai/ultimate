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
}

const EMPTY: DrainReport = { sent: 0, collapsed: 0, remaining: 0, stoppedAt: null };

export function createOutbox(options: OutboxOptions): PageOutbox {
  const principal =
    options.principal ?? ((): ClientScope['principal'] => pageClient().scope.principal);
  const send = options.send ?? sendOverHttp;
  const overlays =
    options.overlays ?? ((): OutboxOverlays | undefined => peekPageRealtime()?.store);
  let queue: OfflineQueue | undefined;

  const open = async (): Promise<void> => {
    queue = await OfflineQueue.open(queueStore(await options.local, scopeKey(principal())));
  };
  let ready = open();

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

  return {
    enqueue: async (entry) => {
      await ready;
      await queue?.enqueue(entry);
    },
    replay: async () => {
      await ready;
      return queue === undefined ? EMPTY : queue.drain(deliver);
    },
    get size(): number {
      return queue?.pending().length ?? 0;
    },
    pending: () => (queue?.pending() ?? []).map(({ key, name, input }) => ({ key, name, input })),
    get ready(): Promise<void> {
      return ready;
    },
  };
}

/** Persisted under the principal; an UNSCOPED page queues in memory only, and loses it on reload. */
function queueStore(local: LocalStore, scope: string | undefined): QueueStore {
  if (scope === undefined) return new MemoryQueueStore();
  return {
    load: async (): Promise<QueueState> =>
      (await local.queue(scope)) ?? { mutations: [], nextSeq: 1 },
    save: (state) => local.saveQueue(scope, state),
  };
}

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
export function pageOutbox(): PageOutbox {
  const host = globalThis as OutboxHost;
  const existing = host[OUTBOX_KEY];
  // Only this function writes the slot, so what it holds is always a `PageOutbox`.
  if (existing !== undefined) return existing as PageOutbox;
  const outbox = createOutbox({ local: pageLocalStore() });
  Object.defineProperty(host, OUTBOX_KEY, { value: outbox, configurable: true });
  if (Reflect.has(globalThis, 'document')) {
    listenForDrain(outbox);
    void outbox.replay().catch(() => undefined);
  }
  return outbox;
}

/**
 * The two drain signals a page can receive: the service worker's `sync` (posted to every open tab
 * as `OUTBOX_DRAIN_MESSAGE`), and the browser coming back `online`. A replay that fails leaves the
 * queue as it was — the next signal tries again — so its rejection is not the listener's to raise.
 */
export function listenForDrain(outbox: Pick<PageOutbox, 'replay'>): () => void {
  const replay = (): void => void outbox.replay().catch(() => undefined);
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
