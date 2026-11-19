// The platform's brief reader, copied: which list items count as rows, and the header it counts.

import { describe, expect, test } from 'bun:test';
import { briefRowsOf, headedBrief } from './brief-rows';

describe('unit · brief-rows · the rows a brief declares', () => {
  test('reads each backticked id under `## Rows`, in order, without repeats', () => {
    const brief =
      '# B\n\n## Rows\n\n- `a-1` — one\n* `b_2`: two\n- `a-1` again\n\n## After\n\n- `c`';
    expect(briefRowsOf(brief)).toEqual(['a-1', 'b_2']);
  });

  test('a brief with no `## Rows` declares none', () => {
    expect(briefRowsOf('# B\n\n## Check\n\n- `main-green`')).toEqual([]);
  });

  test.each([
    ['inside a fence', '## Rows\n\n```\n- `a`\n```'],
    ['an id the platform refuses', '## Rows\n\n- `Main_Green`\n- `a b`'],
    ['a second `## Rows`', '## Rows\n\n## Rows\n\n- `a`'],
    ['no backticked id', '## Rows\n\n- main-green: passed'],
  ])('reads nothing %s', (_name, brief) => {
    expect(briefRowsOf(brief)).toEqual([]);
  });

  test('the header line names the repo, the rows and the brief file, then a blank line', () => {
    expect(headedBrief('o/r', '.dz/b.md', '## Rows\n\n- `x`\n- `y`')).toBe(
      'dz-checkup v1 repo=o/r rows=x,y brief_file=.dz/b.md\n\n## Rows\n\n- `x`\n- `y`',
    );
  });
});
