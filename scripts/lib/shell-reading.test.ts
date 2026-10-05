// The quote-aware reader under `fix-shell-arg-scan.ts`: openers, comments and prose count only
// outside quotes, and an apostrophe inside a word is English, not a quote.

import { describe, expect, test } from 'bun:test';
import { readShell } from './shell-reading';

describe('readShell', () => {
  test('a segment opener inside quotes is the command text, outside it opens a segment', () => {
    expect(readShell('psql -c "select count(*); x"').opener).toBe(-1);
    expect(readShell('x a; x b').opener).toBe(3);
  });

  test('a # opens a comment only at the start of a word', () => {
    expect(readShell('curl https://h/#/x').commented).toBe(false);
    expect(readShell('x verify   # note').commented).toBe(true);
    expect(readShell("echo '# not a comment'").commented).toBe(false);
  });

  test('prose punctuation is collected only outside quotes', () => {
    expect(readShell('psql -c "select id, name"').prose).toEqual([]);
    expect(readShell('x verify, then').prose).toEqual([8]);
  });

  test('an apostrophe inside a word does not open a quote', () => {
    expect(readShell("the run's steps — a run").prose).toEqual([16]);
  });
});
