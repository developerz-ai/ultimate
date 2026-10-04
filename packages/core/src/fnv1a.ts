// 32-bit FNV-1a: a BUCKET, never a key. Rollout buckets and factory seeds need a hash every process
// computes identically and synchronously; anything that decides who shares what is `fingerprint`
// (`canonical-json.ts`), because 2^32 values collide offline in seconds.

const FNV_OFFSET_BASIS = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/**
 * The published 32-bit FNV-1a over UTF-16 code units, unsigned. Pure and dependency-free, which is
 * the property its two callers need: two nodes place one subject in one bucket without talking.
 */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
