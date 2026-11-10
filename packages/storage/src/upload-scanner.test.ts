// The `uploadScanner` slot and its memory reference: EICAR is found wherever the stream cuts it,
// clean bytes are clean, and an install is undone by its own release only.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  installUploadScanner,
  resetUploadScanner,
  type UploadScanner,
  uploadScanner,
} from './upload-scanner';
import { EICAR_TEST_STRING, memoryUploadScanner } from './upload-scanner-memory';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A body cut into `size`-byte chunks — a scanner that matched per chunk misses EICAR across one. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.subarray(at, at + size));
      at += size;
    },
  });
}

const scan = (scanner: UploadScanner, bytes: Uint8Array, size = bytes.byteLength) =>
  scanner.scan({
    key: 'org/o/pending/u.txt',
    size: bytes.byteLength,
    contentType: 'text/plain',
    body: chunked(bytes, Math.max(1, size)),
  });

afterEach(() => resetUploadScanner());

describe('memoryUploadScanner', () => {
  test('the EICAR test file is infected, with a signature naming it', async () => {
    const verdict = await scan(memoryUploadScanner(), encode(EICAR_TEST_STRING));
    expect(verdict).toEqual({ verdict: 'infected', signature: 'EICAR-Test-File' });
  });

  test('EICAR split across one-byte chunks is still found', async () => {
    const verdict = await scan(memoryUploadScanner(), encode(`hello ${EICAR_TEST_STRING}`), 1);
    expect(verdict.verdict).toBe('infected');
  });

  test('clean and empty bodies are clean', async () => {
    expect(await scan(memoryUploadScanner(), encode('a plain note'))).toEqual({ verdict: 'clean' });
    expect(await scan(memoryUploadScanner(), new Uint8Array())).toEqual({ verdict: 'clean' });
  });

  test('the literal is the 68-byte EICAR string', () => {
    expect(EICAR_TEST_STRING).toHaveLength(68);
    expect(EICAR_TEST_STRING.startsWith('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR')).toBe(true);
  });
});

describe('the uploadScanner slot', () => {
  test('answers nothing until a scanner is installed, and nothing after its release', () => {
    expect(uploadScanner()).toBeUndefined();
    const scanner = memoryUploadScanner();
    const release = installUploadScanner(scanner);
    expect(uploadScanner()).toBe(scanner);
    release();
    expect(uploadScanner()).toBeUndefined();
  });
});
