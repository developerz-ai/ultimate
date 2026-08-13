// Single responsibility: a string comparison whose duration does not depend on where two secrets
// first differ. `@ultimat3/auth` and `@ultimat3/storage` both compared a signature or a hashed
// token this way and, being tier 1+ packages that both sit below `@ultimat3/core`, neither is the
// other's dependency — so the one copy lives here, at the tier both can reach.

/**
 * Length is compared first and non-constant-time on purpose: every secret this compares is a
 * fixed-width hash, token or signature, so the length carries no information, and the XOR
 * accumulator below is what has to be branch-free.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
