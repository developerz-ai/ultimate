// The jobs dashboard is built from the admin's primitives and nothing else: no file here fetches,
// opens a socket or an event stream, or writes a table by hand — the list is the admin's list and
// the per-name table is `@ultimat3/ui`'s `DataTable`. Read off the source, so a new file is held to
// it the day it lands.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a fetch', /\bfetch\(/],
  ['a socket', /\bnew WebSocket\b|\bBun\.(?:serve|connect|listen)\b/],
  ['an event stream', /\bEventSource\b|text\/event-stream/],
  ['a hand-written table', /<(?:table|thead|tbody|tr|td|th)\b/],
];

describe('packages/admin/src/jobs', () => {
  test('ships no fetch, no socket, no event stream and no hand-written table', async () => {
    const found: string[] = [];
    for await (const file of new Glob('*.{ts,tsx}').scan({ cwd: import.meta.dir })) {
      if (file.includes('.test.') || file.endsWith('-fixture.ts')) continue;
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(source)) found.push(`${file}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });
});
