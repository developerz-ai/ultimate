// The store a PRIMITIVE's declared `rateLimit:` is counted in — `@ultimat3/action`'s `invoke` and
// `@ultimat3/query`'s read path both spend from it, on every surface. One slot, here, so the two
// tier-3 packages (which cannot import each other) count in one place, and the boot fills it with
// the same instance it hands `httpServer({ rateLimitStore })`.

import type { RateLimitConfig, RateLimitStore } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import { rateLimitNotShared } from './rate-limit-errors';

/** What a process falls back to when nothing chose: one process' memory. */
let base: RateLimitStore = memoryRateLimitStore();
let baseChosen = false;
/**
 * Adopted stores, newest last. A STACK of frames, each popped only by its own adopter: two
 * servers started A-then-B and stopped A-then-B used to have A's stop restore what A replaced —
 * reverting the slot under B while B still served. A frame object is its own identity, so the
 * same store adopted twice is two frames.
 */
const frames: { readonly store: RateLimitStore }[] = [];

const current = (): RateLimitStore => frames.at(-1)?.store ?? base;
const isChosen = (): boolean => baseChosen || frames.length > 0;

/**
 * The embedder's one-line install, for a process that builds its own boot: the base everything
 * else stacks over. Left at the default it is one process' memory — right for dev and tests, and
 * N × every declared limit behind N replicas, which `assertInstalledRateLimitScope` refuses under
 * a `'shared'` declaration. A boot that has to give the slot back uses `adoptRateLimitStore`.
 */
export const installRateLimitStore = (store: RateLimitStore): void => {
  base = store;
  baseChosen = true;
};

export const installedRateLimitStore = (): RateLimitStore => current();

/** Test-only. Every frame and the base, back to one process' memory. */
export const resetRateLimitStore = (): void => {
  frames.length = 0;
  base = memoryRateLimitStore();
  baseChosen = false;
};

export interface AdoptRateLimitStoreOptions {
  /**
   * `httpServer`'s rule: never over a store something already CHOSE. The boot installs its own
   * before any server exists, and a server handed a different one must not move every action's
   * counters out from under it — the chosen one stands, and `assertInstalledRateLimitScope` still
   * holds it to the declaration.
   */
  readonly keepChosen?: boolean;
}

/**
 * Push `store` as the one primitives spend from, and answer the undo that removes THIS frame and
 * no other — whatever order the adopters stop in. The boot (`startServices`, `startRoles`) and
 * `httpServer` all go through it, so every install has a matching, order-proof release.
 */
export const adoptRateLimitStore = (
  store: RateLimitStore,
  options: AdoptRateLimitStoreOptions = {},
): (() => void) => {
  if (options.keepChosen === true && isChosen() && current() !== store) return () => undefined;
  const frame = { store };
  frames.push(frame);
  return () => {
    const at = frames.indexOf(frame);
    if (at !== -1) frames.splice(at, 1);
  };
};

/**
 * `assertRateLimitScope`'s rule for the primitives' half: a `'shared'` declaration says every
 * number is the fleet's, and an action or query limit counted in one process' memory is not.
 */
export const assertInstalledRateLimitScope = (config: RateLimitConfig): void => {
  if (config.scope !== 'shared') return;
  if (current().scope !== 'shared') throw rateLimitNotShared('installed');
};
