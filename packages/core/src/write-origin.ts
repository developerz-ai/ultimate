// The write in flight on the server: the digest of the idempotency key the request that is
// running arrived with. `@ultimat3/action`'s HTTP projection opens the scope; the layers that turn
// a committed row into a `records` frame read it — entity's row observer in-process, and the
// Postgres driver, which writes it into the WAL for the replicator to find. Server-only: it rides
// core's one `AsyncLocalStorage` seam, which a browser bundle does not have.

import { asyncContext } from './async-context';
import { isWriteDigest } from './write-digest';

const origin = asyncContext<string>('the write origin');

/**
 * The `pg_logical_emit_message` prefix a keyed write's transaction opens with, its content the
 * digest. `@ultimat3/entity`'s Postgres driver writes it; `@ultimat3/realtime`'s replication stream
 * reads it and names every change of that transaction. One constant, so the two cannot drift.
 */
export const WRITE_ORIGIN_WAL_PREFIX = 'ultimate.write';

/**
 * Run `fn` as the write named `digest` (`writeDigest(key)`). Anything but a digest runs `fn`
 * unnamed — the scope is a label on frames, never a gate, so a malformed one costs the page its
 * echo match and nothing else.
 */
export function withWriteOrigin<T>(digest: string | undefined, fn: () => T): T {
  return isWriteDigest(digest) ? origin.run(digest, fn) : fn();
}

/** The digest of the write this code runs inside, or `undefined` outside every keyed write. */
export function currentWriteOrigin(): string | undefined {
  return origin.get();
}
