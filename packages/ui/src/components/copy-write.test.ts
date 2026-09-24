// The clipboard write behind `CopyButton`. It showed "Copied" when `navigator.clipboard` was
// undefined, and a `writeText` rejection (permission denied, an insecure origin) escaped as an
// unhandled rejection through `void onClick()` — the check mark lied and the console threw.

import { describe, expect, test } from 'bun:test';
import { writeToClipboard } from './copy-write';

describe('writeToClipboard', () => {
  test('no clipboard at all is a failed copy, never a claimed one', async () => {
    expect(await writeToClipboard('x', undefined)).toBe(false);
  });

  test('a rejected write is a failed copy, and nothing is left unhandled', async () => {
    const denied = {
      writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    };
    expect(await writeToClipboard('x', denied)).toBe(false);
  });

  test('a write that resolves is the only success', async () => {
    const written: string[] = [];
    const clipboard = {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    };
    expect(await writeToClipboard('https://x.test/a', clipboard)).toBe(true);
    expect(written).toEqual(['https://x.test/a']);
  });
});
