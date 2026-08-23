// Evicting every socket a drain holds, in bounded chunks, and waiting out what each eviction put
// on the bus. Split out of `sync-node.ts` at the 500-line ceiling; the loop closes over nothing the
// node holds, which is the same seam `detach.ts` took.

/** Sockets evicted before the leaves they started are awaited. See `evictInChunks`. */
export const DRAIN_EVICT_CHUNK = 128;

/**
 * Every socket released, then the writes those releases started, then the next chunk.
 *
 * Chunked rather than one pass, because an eviction's presence leave is a write per TOPIC per
 * SOCKET: a node holding 50,000 sockets in a handful of rooms each would open a quarter of a
 * million KV writes on one connection in a single synchronous loop, which is a self-inflicted
 * thundering herd on the bus at the exact moment the fleet is already restarting.
 *
 * `allSettled`, never `all`: a leave that fails is a member left to its TTL — the same degradation
 * the write has when nobody waits for it at all — and it must not stop the sockets behind it from
 * being released. The failure itself is already reported, by the `detach` the eviction path
 * attached before handing the promise back here.
 */
export async function evictInChunks<Socket>(
  sockets: readonly Socket[],
  evict: (socket: Socket) => readonly Promise<unknown>[],
  chunkSize: number = DRAIN_EVICT_CHUNK,
): Promise<void> {
  for (let start = 0; start < sockets.length; start += chunkSize) {
    const pending: Promise<unknown>[] = [];
    for (const socket of sockets.slice(start, start + chunkSize)) pending.push(...evict(socket));
    await Promise.allSettled(pending);
  }
}
