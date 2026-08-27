// Single responsibility: pinning a connection out of the pool under the profile's acquire deadline,
// and giving back a reservation that arrives after the deadline has passed. Split from `client.ts`,
// which now asks for a pin rather than owning what "waited too long" means.

import { type BunSqlDriver, type BunSqlReserved, releaseReserved } from './bun-sql';
import { poolAcquireTimeout } from './errors';
import type { PoolProfile } from './pool-profile';

/**
 * `pool.reserve()` under a deadline. Without one an exhausted pool does not fail, it **queues** —
 * so a slow endpoint filling all 20 slots turns every later request, `/readyz`'s `select 1`
 * included, into a wait with no end and no error, and the pod is killed for being unready rather
 * than answering 503 for the requests it cannot serve.
 *
 * The losing reservation is released, never dropped: the pool hands out a connection whenever one
 * frees, deadline or no deadline, and a pin nobody holds is a connection nobody gets back. That is
 * the whole reason this is not a bare `Promise.race`.
 */
export async function reserveWithin(
  pool: Pick<BunSqlDriver, 'reserve'>,
  profile: PoolProfile,
): Promise<BunSqlReserved> {
  const budget = profile.acquireTimeoutMs;
  if (budget <= 0) return pool.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const pending = pool.reserve();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(poolAcquireTimeout(budget, profile.max));
        }, budget);
        // The deadline must not be what keeps a finished process alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Attached unconditionally so a rejection arriving after we gave up is handled, not unhandled.
    void pending.then(
      (late) => {
        if (expired) releaseReserved(late);
      },
      () => undefined,
    );
  }
}
