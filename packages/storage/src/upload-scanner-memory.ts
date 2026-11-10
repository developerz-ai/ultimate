// The reference `UploadScanner`: finds the EICAR test file, the one byte string every antivirus
// agrees is a virus and no file legitimately contains. A test's scanner and the shape an app's
// ClamAV adapter copies — streamed, matched across chunk boundaries, no state between calls.

import type { ScanInput, ScanVerdict, UploadScanner } from './upload-scanner';

/**
 * The 68-byte EICAR anti-malware test string. Assembled from two halves so this source file is not
 * itself a detection on a developer's machine or in a registry scan.
 */
export const EICAR_TEST_STRING = `${'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'}${'-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'}`;

const SIGNATURE = 'EICAR-Test-File';
const NEEDLE = new TextEncoder().encode(EICAR_TEST_STRING);

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let at = 0; at + needle.byteLength <= haystack.byteLength; at += 1) {
    for (let i = 0; i < needle.byteLength; i += 1) {
      if (haystack[at + i] !== needle[i]) continue outer;
    }
    return at;
  }
  return -1;
}

/**
 * Reads the body to the end (or to the first match, then cancels it), keeping only the last
 * `NEEDLE.length - 1` bytes between chunks: a match split by the stream is still a match, and the
 * heap never holds more than one chunk plus that tail.
 */
async function containsEicar(body: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = body.getReader();
  let tail = new Uint8Array();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      const window = new Uint8Array(tail.byteLength + value.byteLength);
      window.set(tail);
      window.set(value, tail.byteLength);
      if (indexOf(window, NEEDLE) !== -1) {
        await reader.cancel();
        return true;
      }
      tail = window.slice(Math.max(0, window.byteLength - (NEEDLE.byteLength - 1)));
    }
  } finally {
    reader.releaseLock();
  }
}

/** Infected exactly when the bytes contain the EICAR string, anywhere. Never unavailable. */
export function memoryUploadScanner(): UploadScanner {
  return {
    name: 'memory',
    async scan(input: ScanInput): Promise<ScanVerdict> {
      return (await containsEicar(input.body))
        ? { verdict: 'infected', signature: SIGNATURE }
        : { verdict: 'clean' };
    },
  };
}
