// The gate rule that keeps `wiki/Realtime.md` and `FRAME_KINDS` naming the same frames. The
// negative cases are FIXTURES — a fake kind list over a fake page — never an edit to the published
// page, which the gate reads while this suite runs.

import { describe, expect, test } from 'bun:test';
import { FRAME_KINDS } from '@ultimat3/realtime';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkFrameDocs, FRAMES_PAGE, frameDocGapFindingFor, frameDocGaps } from './wiki-frames';

const findings = (page: string | undefined, kinds: readonly string[] = ['hello', 'patch']) =>
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

describe('unit · a page that is not there', () => {
  /**
   * The rule's own false green: deleting `wiki/Realtime.md` satisfied every comparison below by
   * leaving nothing to compare, so the `manifest` step reported pass over a wire protocol with no
   * public description. A missing input is not "nothing to check" — it is the most likely state
   * during exactly the rename this rule guards.
   */
  test('is a finding, not a pass', () => {
    const found = findings(undefined);

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_FRAME_DOCS_STALE');
    expect(found[0]?.cause).toContain('does not exist');
    expect(found[0]?.cause).toContain('nothing to compare');
    expect(found[0]?.fix).toContain('git checkout');
    expect(found[0]?.at).toBe(FRAMES_PAGE);
  });

  test('one finding, not one per frame — the page is one fact and one edit', () => {
    expect(findings(undefined, ['a', 'b', 'c', 'd'])).toHaveLength(1);
  });

  test('a tree that ships no wire owes no page', () => {
    // The guard that keeps the rule silent on a synthetic root, derived rather than exempted.
    expect(findings(undefined, [])).toEqual([]);
  });

  test('an EMPTY page is not an absent one — it documents nothing and says so', () => {
    expect(findings('').map((one) => one.code)).toEqual([
      'X_FRAME_DOCS_STALE',
      'X_FRAME_DOCS_STALE',
    ]);
    expect(findings('')[0]?.cause).toContain('never names it');
  });
});

describe('unit · this repo', () => {
  /**
   * The live rule against the real tree, green today. The `FRAME_KINDS.length` guard is the vacuity
   * check and NOTHING more: an empty kind list would make the whole rule pass over any page, which
   * is this file's own failure mode one level up.
   *
   * A LOWER BOUND, deliberately, not `toBe(10)`. Pinning the count makes adding a wire frame fail a
   * rule that is working correctly — the author documents the new frame, the page is right, and
   * this line still goes red — which trains a reader to edit the number instead of reading the
   * failure. Whether a new frame is documented is `frameDocGaps`' answer, on the line below.
   */
  test(
    'every wire frame is named on the public page, and the page invents none',
    async () => {
      expect(FRAME_KINDS.length).toBeGreaterThan(5);
      expect(await frameDocGaps(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
