// The store a PRIMITIVE's declared `rateLimit:` is counted in — and, since 31.0.0, the one the
// HTTP pipeline's limiter counts in too. `@ultimat3/action`'s `invoke` and `@ultimat3/query`'s
// read path both spend from it, on every surface; one slot, here, so the two tier-3 packages
// (which cannot import each other) and every `httpServer` count in one place.

import { adapterSlot } from '@ultimat3/core/adapter';
import type { Bucket, RateLimitConfig, RateLimitStore } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import { rateLimitNotShared } from './rate-limit-errors';

/** What a process falls back to when nothing installed one: one process' memory. */
let base: RateLimitStore = memoryRateLimitStore();
/**
 * Installed stores over the base: core's `adapterSlot`, a stack each release pops only its own
 * frame from — two boots stopped in either order never revert the slot under the one still serving.
 */
const slot = /* @__PURE__ */ adapterSlot<RateLimitStore>(() => base);

const current = (): RateLimitStore => slot.current();

/**
 * The boot's install, and the only one: exported from `@ultimat3/http/adapter`, never from the
 * package's `.` barrel. An app does not call it — it names its store as `rateLimitStore` in
 * `apps/<app>/runtime.ts` and the boot installs that, or `postgresRateLimitStore` over the pool it
 * opened. Answers the undo that removes THIS frame and no other, whatever order installers stop in.
 */
export const installRateLimitStore = (store: RateLimitStore): (() => void) => slot.install(store);

export const installedRateLimitStore = (): RateLimitStore => current();

/**
 * The slot as a store: every call reads whatever is installed AT THAT CALL. What `httpServer`'s
 * limiter counts in, so a store installed after the server was built — a test's override seam, a
 * boot that orders its installs differently — is the one a request spends from. Its `scope` is
 * read live too; the boot check reads it once, when the pipeline is built.
 */
export const liveRateLimitStore: RateLimitStore = Object.freeze({
  get scope() {
    return current().scope;
  },
  take: (key: string, bucket: Bucket, cost: number, nowMs: number) =>
    current().take(key, bucket, cost, nowMs),
  peek: (key: string, bucket: Bucket, nowMs: number) => current().peek(key, bucket, nowMs),
  reset: (key: string) => current().reset(key),
});

/**
 * The per-test reset: the DEFAULT memory store's buckets emptied, every installed store left where
 * it is. A suite that installed a shared store once (a live Redis or Postgres run) keeps running on
 * it; only the fallback a plain unit test counts in forgets what the previous test spent.
 */
export const clearDefaultRateLimitBuckets = (): void => {
  base = memoryRateLimitStore();
};

/** Test-only. Every frame and the base, back to one process' memory. */
export const resetRateLimitStore = (): void => {
  slot.reset();
  base = memoryRateLimitStore();
};

/**
 * `assertRateLimitScope`'s rule for the primitives' half: a `'shared'` declaration says every
 * number is the fleet's, and an action or query limit counted in one process' memory is not.
 */
export const assertInstalledRateLimitScope = (config: RateLimitConfig): void => {
  if (config.scope !== 'shared') return;
  if (current().scope !== 'shared') throw rateLimitNotShared('installed');
};

/**
 * `fn` spending from a fresh store of its own, the installed one left exactly as it was — the
 * contract exercise's runs (`@ultimat3/action`, `@ultimat3/query`): a test-time loop that must not
 * leave the same file's next call a 429. It answers for the installed store's scope, so a
 * `'shared'` declaration is still judged against what the app installed, not the scratch.
 */
export async function withScratchRateLimitStore<T>(fn: () => Promise<T>): Promise<T> {
  const scratch = memoryRateLimitStore();
  const release = installRateLimitStore({
    scope: current().scope,
    take: (key, bucket, cost, nowMs) => scratch.take(key, bucket, cost, nowMs),
    peek: (key, bucket, nowMs) => scratch.peek(key, bucket, nowMs),
    reset: (key) => scratch.reset(key),
  });
  try {
    return await fn();
  } finally {
    release();
  }
}
