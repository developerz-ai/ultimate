// Whether a secret occurs in a piece of text, without a search that stops at the first differing
// byte. `.includes(secret)` answers sooner the more of a window matches the secret's prefix — the
// oracle `scripts/secret-compare.ts` refuses — so every window is compared whole, in constant time.

import { timingSafeEqual } from '@ultimat3/core';

/** True when `secret` occurs in `text`. Time depends on the two lengths, never on their bytes. */
export function containsSecret(text: string, secret: string): boolean {
  const width = secret.length;
  if (width === 0) return false;
  let found = false;
  for (let start = 0; start + width <= text.length; start += 1) {
    // `timingSafeEqual` first, so a window after a hit is still compared rather than skipped.
    found = timingSafeEqual(text.slice(start, start + width), secret) || found;
  }
  return found;
}
