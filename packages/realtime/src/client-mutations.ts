// The outbound mutation path: the optimistic twin, the durable queue entry, and the sender the
// drain hands each frame to. One file because those are the three places a single intent is
// recorded, and an intent that reaches two of them is the divergence tier 3 exists to prevent.

import { uuid } from '@ultimat3/core';
import type { ClientSocket, MutatorRef } from './client-contract';
import { TransportUnavailableError } from './errors';
import type { JsonValue } from './json';
import type { LocalStore, TableMap } from './local-store';
import { type MutationSender, mutateFrame, type OfflineQueue } from './offline-queue';
import type { RebaseLog } from './rebase';
import { encode, type Frame } from './sync-protocol';

/**
 * Queued bytes past which the drain stops rather than adds. The same number the node uses at its
 * end of the socket (`DEFAULT_MAX_BUFFERED_BYTES`), and deliberately NOT imported from it: this is
 * browser code, and `socket.ts` is the node's socket registry, its metrics and its close codes —
 * one import pulls the whole server half into the tab's bundle to read an integer. The node's two
 * spellings were merged because they configure one buffer on one side; these are two sides.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Everything the mutation path touches. Narrow on purpose, exactly like `ClientFrameTarget`. */
export interface MutationDeps<T extends TableMap = TableMap> {
  readonly store: LocalStore<T> | undefined;
  readonly queue: OfflineQueue | undefined;
  readonly log: RebaseLog<T> | undefined;
  readonly now: () => number;
  /** Read per send, never captured: the socket a drain started on may already be gone. */
  socket(): ClientSocket | null;
  send(frame: Frame): void;
}

/**
 * Record one intent everywhere it has to be recorded: the local store (so the UI moves now), the
 * rebase log (so it can be taken back) and the durable queue (so it survives the tab). Nothing is
 * sent here — `drain` is the only thing that puts a mutation on a socket, and with no queue at all
 * (tier 2) the frame goes straight out because there is nothing to drain it from later.
 */
export async function recordMutation<T extends TableMap>(
  deps: MutationDeps<T>,
  mutator: MutatorRef<T>,
  input: JsonValue,
  key?: string,
): Promise<void> {
  const idempotencyKey = key ?? `${mutator.name}:${uuid()}`;
  const { store, queue } = deps;
  const local = mutator.local;
  const existing = queue?.find(idempotencyKey);
  const queued = await queue?.enqueue({
    key: idempotencyKey,
    name: mutator.name,
    input,
    at: deps.now(),
  });
  // Identity, not a second copy of the queue's collapse rule: `enqueue` hands back the SAME entry
  // when it collapses and a new one when it does not. A repeated key is ONE intent whose twin is
  // already applied — applying it again double-counts the write (a like becomes two) and replaces
  // the log entry a rollback would have undone to the pre-mutation row.
  const collapsed = existing !== undefined && queued === existing;
  if (store && local && !collapsed) {
    store.apply(idempotencyKey, (tx) => local(tx, input));
    deps.log?.record({
      key: idempotencyKey,
      seq: queued?.seq ?? 0,
      entity: mutator.entity ?? mutator.name,
      strategy: mutator.conflict ?? 'server-wins',
      apply: (tx) => local(tx, input),
    });
  }
  if (queue) return;
  deps.send(
    mutateFrame({
      key: idempotencyKey,
      seq: 0,
      name: mutator.name,
      input,
      enqueuedAt: deps.now(),
      attempts: 0,
      status: 'pending',
      error: null,
    }),
  );
}

/**
 * The queue's sender. Throwing is how a sender declines: the queue keeps that mutation pending,
 * stops the pass rather than reordering the ones behind it, and the next drain resumes there.
 *
 * Backpressure is a decline and not a failure — the frames already queued in the tab are ones the
 * socket has not managed to write, so adding to them is how a client sends a burst it will never
 * see acknowledged. A socket that does not report `bufferedAmount` is treated as never backed up.
 */
export function mutationSender<T extends TableMap>(deps: MutationDeps<T>): MutationSender {
  return async (mutation) => {
    const socket = deps.socket();
    if (!socket) {
      throw new TransportUnavailableError({
        transport: 'websocket',
        reason: 'the socket went away before this mutation reached it',
        fix: 'it stays queued: await useMutationQueue().drain() once useConnection().online',
      });
    }
    const buffered = socket.bufferedAmount ?? 0;
    if (buffered > MAX_BUFFERED_BYTES) {
      throw new TransportUnavailableError({
        transport: 'websocket',
        reason: `${buffered} bytes are already queued on this socket, over the ${MAX_BUFFERED_BYTES} ceiling`,
        fix: 'it stays queued: await useMutationQueue().drain() once the socket has caught up',
      });
    }
    socket.send(encode(mutateFrame(mutation)));
  };
}
