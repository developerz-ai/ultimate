// UTF-8 byte length counted off the UTF-16 code units, allocating nothing. Every byte budget in
// this package (the LRU, the request memo) charges through it, so `TextEncoder.encode` — a full
// copy of the payload — never runs just to read `.byteLength` off the copy.

/**
 * What `new TextEncoder().encode(text).byteLength` answers, without the copy. A surrogate PAIR is
 * one astral code point, 4 bytes; a LONE surrogate is encoded as U+FFFD, 3 bytes — the same
 * replacement `TextEncoder` makes, so the two never disagree on a budget.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  const length = text.length;
  for (let i = 0; i < length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}
