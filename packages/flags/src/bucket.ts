// Single responsibility: the stable bucket a (flag, actor) pair falls into. Never `Math.random()`:
// a rollout that re-rolls per call shows one user the new experience on one request and the old
// one on the next, which is a worse product than no rollout at all — and untestable besides.

/** A rollout is declared as a percentage, so the bucket space is 100. */
export const BUCKETS = 100;

const FNV_OFFSET_BASIS = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/**
 * 32-bit FNV-1a. Chosen over a cryptographic digest because bucketing is not a security decision
 * and this one is synchronous, dependency-free and identical in every process — which is the
 * property that matters: two nodes must agree about one actor without talking to each other.
 */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * The flag key is hashed WITH the actor id, not the actor id alone: hashing the actor by itself
 * would put the same unlucky cohort in the first 10% of every 10% rollout the app ever runs, so
 * one group of users would meet every half-finished feature in the product.
 */
export const bucketOf = (key: string, actorId: string): number =>
  fnv1a(`${key}:${actorId}`) % BUCKETS;
