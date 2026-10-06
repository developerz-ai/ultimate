// The DATE-FIRST stamp: `` `As of 2026-08-20`: … at 4.0.0 ``. The grammar read only version-then-
// date, so the two stale claims in `PUBLISHING.md` that put the date first slipped the rule.
// Fixtures only — the live pages move every release (`scripts/version-stamps.test.ts` says why).

import { describe, expect, test } from 'bun:test';
import { readStamps, rewriteStamps } from './version-stamp-scan';

const seen = (text: string): readonly string[] =>
  readStamps({ path: 'wiki/Whatever.md', text }).map((stamp) => stamp.version);

describe('a stamp with the date first', () => {
  test('the PUBLISHING.md lead: a date, then the version later in the sentence', () => {
    expect(
      seen(
        '**`As of 2026-08-20`: 31 workspaces publish, all 30 are on the registry at 4.0.0, and…',
      ),
    ).toEqual(['4.0.0']);
  });

  test('a backtick-quoted command between them is the same claim', () => {
    expect(seen('`As of 2026-08-20` `git describe` answers `v4.0.0` and the check passes')).toEqual(
      ['4.0.0'],
    );
  });

  test('a sentence end before the version ends the claim', () => {
    expect(seen('`As of 2026-08` the guard is green. Tauri ships 2.10.1 now.')).toEqual([]);
  });

  test('a version too far past the date is another claim', () => {
    expect(seen(`\`As of 2026-08\` ${'x'.repeat(100)} 4.0.0`)).toEqual([]);
  });

  test('the version-first form still reads once, never twice', () => {
    expect(seen('v9.0.0 `As of 2026-08`. Stable API.')).toEqual(['9.0.0']);
  });

  test('inside a fence it is an example', () => {
    expect(seen('```\n`As of 2026-08` v1.1.0\n```')).toEqual([]);
  });
});

describe('the rewriter moves the date-first version, and only it', () => {
  test('the version at the END of the match moves; an earlier look-alike does not', () => {
    // `14.0.0-rc1` is no stamp (suffixed), but it CONTAINS `4.0.0`: a first-occurrence replace
    // would rewrite the rc and leave the claim.
    const page = '`As of 2026-08-20` after 14.0.0-rc1, at 4.0.0';
    const { text, moved } = rewriteStamps({ path: 'wiki/_Footer.md', text: page }, '5.0.0');
    expect(moved).toBe(1);
    expect(text).toBe('`As of 2026-08-20` after 14.0.0-rc1, at 5.0.0');
  });
});
