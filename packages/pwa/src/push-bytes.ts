// Single responsibility: the byte vocabulary Web Push is spelled in — base64url without padding
// (every key, salt and JWT segment on the wire) and concatenation. `btoa`/`atob`, standard
// globals, never `node:buffer`; `Uint8Array.fromBase64` is in Bun but not in the TypeScript lib.

/** Unpadded base64url, the alphabet RFC 8291 and RFC 8292 print every value in. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * `undefined` for text that is not base64url, rather than a throw: every caller is holding a value
 * someone else wrote (a browser's subscription, an environment variable) and refuses it under its
 * own code, naming which value it was.
 */
export function tryDecodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return undefined;
  const standard = text.replace(/=+$/, '').replaceAll('-', '+').replaceAll('_', '/');
  if (standard.length % 4 === 1) return undefined;
  try {
    const binary = atob(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '='));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
