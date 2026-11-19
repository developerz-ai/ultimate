// "Stop the holder, run it alone, start again" is one line with one quoting rule: every site that
// prints it asks the builder, so the four spellings cannot come back.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path API; `join` reaches each module from this directory.
import { join } from 'node:path';
import { stopRunStartFix } from './stop-run-start';

const DIR = import.meta.dir;

describe('unit · stop, run it, start again', () => {
  test('the command runs between x stop and x dev, word by word', () => {
    expect(stopRunStartFix(['db', 'migrate'])).toBe('x stop --json && x db migrate && x dev');
    expect(stopRunStartFix(['db', 'rollback', '--steps', '2'])).toBe(
      'x stop --json && x db rollback --steps 2 && x dev',
    );
  });

  test('a word the shell would split or run is quoted, never spliced', () => {
    expect(stopRunStartFix(['db', 'seed', 'a b; rm -rf /'])).toBe(
      "x stop --json && x db seed 'a b; rm -rf /' && x dev",
    );
  });

  test('no other module assembles the line by hand', async () => {
    const byHand: string[] = [];
    for await (const file of new Bun.Glob('*.{ts,tsx}').scan({ cwd: DIR })) {
      if (file.includes('.test.') || file === 'stop-run-start.ts') continue;
      const text = await Bun.file(join(DIR, file)).text();
      // A restart (`x stop --json && x dev`) is another instruction: nothing runs in between.
      if (/x stop --json && x (?!dev\b)/.test(text) || /'stop', '--json', '&&'/.test(text)) {
        byHand.push(file);
      }
    }
    expect(byHand).toEqual([]);
  });
});
