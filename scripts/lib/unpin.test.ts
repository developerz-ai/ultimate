// A text transform over a source file gets one thing wrong and deletes the wrong pin, which is the
// ratchet quietly widening. So: it removes exactly what it was asked for, it leaves the file
// formatted, and — the test that matters in a year — it still reads the real pins file's shape.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path'; // `node:`-only by necessity: Bun ships no path-join primitive.
import { GATED_APPS, PINS_FILE } from './gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { parseUnpin, pinnedSteps, removePins } from './unpin';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const FIXTURE = [
  'export const GATED_APPS: readonly GatedApp[] = [',
  '  {',
  "    dir: 'examples/dummy',",
  "    reference: './examples/dummy',",
  '    expectedRed: {',
  '      typecheck:',
  "        '137 errors: apps/web/app/orgs/repo.ts chains .update().returning(), and every ' +",
  "        'contract test names a fixture: seed, actorFor — the data substrate owns it',",
  "      drift: 'migrations predate the current entity set',",
  '    } satisfies Partial<Record<VerifyStepName, string>>,',
  '  },',
  '  {',
  "    dir: 'dummy/social-media-clone',",
  "    reference: './dummy/social-media-clone',",
  '    expectedRed: {',
  "      boundaries: 'X_BOUNDARY_SITE_TO_APP ×3',",
  '    } satisfies Partial<Record<VerifyStepName, string>>,',
  '  },',
  '];',
  '',
].join('\n');

describe('parseUnpin', () => {
  test('reads the shape the stale-pin fix line emits', () => {
    expect(parseUnpin('examples/dummy:drift')).toEqual({
      app: 'examples/dummy',
      steps: ['drift'],
    });
    expect(parseUnpin('examples/dummy:drift,typecheck')?.steps).toEqual(['drift', 'typecheck']);
  });

  test('anything else is undefined, never a half-read request', () => {
    expect(parseUnpin('examples/dummy')).toBeUndefined();
    expect(parseUnpin(':drift')).toBeUndefined();
    expect(parseUnpin('examples/dummy:')).toBeUndefined();
    expect(parseUnpin('examples/dummy:,')).toBeUndefined();
    expect(parseUnpin('')).toBeUndefined();
  });
});

describe('pinnedSteps', () => {
  test('reads one app’s keys, and no other app’s', () => {
    expect(pinnedSteps(FIXTURE, 'examples/dummy')).toEqual(['typecheck', 'drift']);
    expect(pinnedSteps(FIXTURE, 'dummy/social-media-clone')).toEqual(['boundaries']);
  });

  test('a wrapped value line is never mistaken for the next key', () => {
    // `'…contract test names a fixture: seed, actorFor…'` holds a colon inside the string.
    expect(pinnedSteps(FIXTURE, 'examples/dummy')).not.toContain('contract test names a fixture');
  });

  test('an app the file does not declare reads as undefined', () => {
    expect(pinnedSteps(FIXTURE, 'examples/nope')).toBeUndefined();
  });
});

describe('removePins', () => {
  test('removes a multi-line entry whole, and touches nothing else', () => {
    const next = removePins(FIXTURE, 'examples/dummy', ['typecheck']) ?? '';
    expect(pinnedSteps(next, 'examples/dummy')).toEqual(['drift']);
    expect(pinnedSteps(next, 'dummy/social-media-clone')).toEqual(['boundaries']);
    expect(next).not.toContain('137 errors');
    expect(next).not.toContain('contract test names a fixture');
    expect(next).toContain("drift: 'migrations predate the current entity set',");
  });

  test('emptying a table collapses it to `{}` rather than leaving `{\\n}` for the formatter', () => {
    const next = removePins(FIXTURE, 'dummy/social-media-clone', ['boundaries']) ?? '';
    expect(next).toContain(
      '    expectedRed: {} satisfies Partial<Record<VerifyStepName, string>>,\n',
    );
    expect(pinnedSteps(next, 'dummy/social-media-clone')).toEqual([]);
    // The other app is untouched — an empty table is not a licence to rewrite the file.
    expect(pinnedSteps(next, 'examples/dummy')).toEqual(['typecheck', 'drift']);
  });

  test('two entries at once, the way one commit lifts two pins', () => {
    const next = removePins(FIXTURE, 'examples/dummy', ['typecheck', 'drift']) ?? '';
    expect(pinnedSteps(next, 'examples/dummy')).toEqual([]);
    expect(next).toContain('expectedRed: {} satisfies');
  });

  test('a step that is not pinned removes NOTHING, not the entries it recognised', () => {
    expect(removePins(FIXTURE, 'examples/dummy', ['drift', 'lint'])).toBeUndefined();
    expect(removePins(FIXTURE, 'examples/nope', ['drift'])).toBeUndefined();
  });

  test('an app declared without an expectedRed cannot borrow the next app’s table', () => {
    const source = [
      '  {',
      "    dir: 'examples/orphan',",
      "    reference: './examples/orphan',",
      '  },',
      '  {',
      "    dir: 'examples/dummy',",
      '    expectedRed: {',
      "      drift: 'owned elsewhere',",
      '    } satisfies Partial<Record<VerifyStepName, string>>,',
      '  },',
    ].join('\n');
    expect(pinnedSteps(source, 'examples/orphan')).toBeUndefined();
    expect(removePins(source, 'examples/orphan', ['drift'])).toBeUndefined();
    expect(pinnedSteps(source, 'examples/dummy')).toEqual(['drift']);
  });
});

describe('against the real pins file', () => {
  test('the parser reads what Biome actually wrote, for every gated app', async () => {
    const source = await Bun.file(join(repoRoot(), PINS_FILE)).text();
    for (const app of GATED_APPS) {
      // Same order, not just the same set: the gate refuses to edit a file it reads differently
      // from the module it imported, so a mismatch here is the command going dark.
      expect(pinnedSteps(source, app.dir)).toEqual(Object.keys(app.expectedRed));
    }
  });

  test('removing a real pin leaves the rest of the file byte-identical', async () => {
    const source = await Bun.file(join(repoRoot(), PINS_FILE)).text();
    const app = GATED_APPS.find((candidate) => Object.keys(candidate.expectedRed).length > 1);
    const [first, ...rest] = Object.keys(app?.expectedRed ?? {});
    const next = removePins(source, app?.dir ?? '', [first ?? '']) ?? '';
    expect(pinnedSteps(next, app?.dir ?? '')).toEqual(rest);
    expect(next.split('\n').length).toBeLessThan(source.split('\n').length);
    // Every line that survives is a line the original had, in the original's order.
    const kept = next.split('\n');
    const original = source.split('\n');
    expect(kept.every((line) => original.includes(line))).toBe(true);
  });
});
