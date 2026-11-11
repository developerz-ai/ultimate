// `logs.tail`'s two halves, split from `mcp-host.test.ts` at its size ceiling: the log is read
// from its END in a bounded window (a 200 MB `dev.log` is never loaded), and `role` names a role,
// never a path segment.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { logTailPath, tailLines } from './mcp-host';

describe('unit · logs.tail', () => {
  const sized = (text: string, padding: number, read: number[]) => ({
    size: padding + text.length,
    slice: (start: number, end: number) => {
      read.push(end - start);
      const from = Math.max(0, start - padding);
      return { text: async () => ' '.repeat(Math.max(0, padding - start)) + text.slice(from) };
    },
  });

  test('a 200 MB log answers its last lines from a bounded read', async () => {
    const read: number[] = [];
    const file = sized('a\nb\nc\nd\n', 200 * 1024 * 1024, read);
    expect(await tailLines(file, 2)).toEqual(['c', 'd']);
    expect(read.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(1024 * 1024);
  });

  test('a last line longer than the cap is answered cut, never as nothing', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const tail = await tailLines(sized(`${huge}\n`, 0, []), 5);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.length).toBeGreaterThan(0);
  });

  test('a small file answers whole, without its trailing newline', async () => {
    expect(await tailLines(sized('one\ntwo\n', 0, []), 100)).toEqual(['one', 'two']);
  });

  test('a role is a role: web resolves under logs/, a path segment is refused', () => {
    expect(logTailPath('/s', undefined)).toBe(join('/s', 'dev.log'));
    expect(logTailPath('/s', 'web')).toBe(join('/s', 'logs', 'web.log'));
    for (const role of ['../x', '../../etc/passwd', 'web/../../x', '']) {
      expect(() => logTailPath('/s', role)).toThrow(
        expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
      );
    }
  });
});
