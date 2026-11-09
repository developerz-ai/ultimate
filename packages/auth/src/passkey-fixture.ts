// Test-only: the smallest tampering there is, over the software authenticator's output
// (`soft-authenticator.ts`, the one implementation, public from `@ultimat3/testing`). Never
// imported by source.

import { base64Url, base64UrlBytes } from './base64url';

/** One byte of a base64url field flipped — the smallest tampering there is. */
export function flipByte(field: string, index = 0): string {
  const bytes = base64UrlBytes(field) ?? new Uint8Array();
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return base64Url(bytes);
}
