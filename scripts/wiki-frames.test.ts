// The gate rule that keeps `wiki/Realtime.md` and `FRAME_KINDS` naming the same frames. The
// negative cases are FIXTURES — a fake kind list over a fake page — never an edit to the published
// page, which the gate reads while this suite runs.

import { describe, expect, test } from 'bun:test';
import { FRAME_KINDS } from '@ultimat3/realtime';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkFrameDocs, FRAMES_PAGE, frameDocGapFindingFor, frameDocGaps } from './wiki-frames';

const findings = (page: string, kinds: readonly string[] = ['hello', 'patch']) =>
  checkFrameDocs({ kinds, page }).map(frameDocGapFindingFor);

describe('unit · a frame the page never names', () => {
  test('is refused, and the fix names the page and the frame', () => {
    const found = findings('The `hello` frame opens the socket.');

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_FRAME_DOCS_STALE');
    expect(found[0]?.cause).toContain('"patch" frame');
    expect(found[0]?.cause).toContain('never names it');
    expect(found[0]?.fix).toContain(FRAMES_PAGE);
    expect(found[0]?.at).toBe(FRAMES_PAGE);
  });

  test('passes once the page names it, backticked or not', () => {
    expect(findings('The `hello` frame opens it; a patch carries rows.')).toEqual([]);
  });

  test('a phrase wrapped across two lines is still one phrase', () => {
    expect(findings('hello\npatch')).toEqual([]);
  });
});

describe('unit · a frame the page invents', () => {
  test('is refused — the published protocol would document a frame no node sends', () => {
    const found = findings('A `hello` frame, then a `delta` frame carries the patch.');

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_FRAME_DOCS_STALE');
    expect(found[0]?.cause).toContain('`delta` frame');
    expect(found[0]?.fix).toContain('FRAME_KINDS');
  });

  test('a backticked token that is not called a frame is left alone', () => {
    // `add` and `drop` are subscribe ops, `sync` is a node role — the page backticks all three.
    expect(findings('hello and patch: `add`, `drop`, and the `sync` node.')).toEqual([]);
  });
});

describe('unit · this repo', () => {
  /**
   * The live rule against the real tree, green today. The `expect(FRAME_KINDS.length)` guard is the
   * vacuity check: an empty kind list would make the whole rule pass over any page at all, which is
   * this file's own failure mode reintroduced one level up.
   */
  test(
    'every wire frame is named on the public page, and the page invents none',
    async () => {
      expect(FRAME_KINDS.length).toBe(10);
      expect(await frameDocGaps(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
