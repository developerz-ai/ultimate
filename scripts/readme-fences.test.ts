// The failure case first: a package with more failing examples than the ratchet pins. Then the
// two ways this rule stops being one — a pin nobody tightens, and a run where nothing was compiled
// at all, which is the false green three of this month's other gate checks shipped with.

import { describe, expect, test } from 'bun:test';
import {
  buildFixtures,
  fenceOf,
  isSyntactic,
  parseDiagnostics,
  readFences,
} from './lib/readme-fences';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkFences,
  failuresFrom,
  fenceFailures,
  fenceGapFindingFor,
  pinnedSource,
} from './readme-fences';
import { README_FENCE_BACKLOG } from './readme-fences-backlog';

const fail = (pkg: string, readmeLine: number) => ({
  pkg,
  readmeLine,
  reason: 'TS2304: Cannot find name.',
});

describe('a package with more failing examples than it is pinned at', () => {
  test('is the finding, and it names the README line and the compiler', () => {
    const gaps = checkFences({
      packages: ['render'],
      failures: [fail('render', 80), fail('render', 120)],
      backlog: { render: 1 },
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('over');
    const finding = fenceGapFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_README_EXAMPLE_UNCOMPILED');
    expect(finding.at).toBe('packages/render/README.md:80');
    expect(finding.cause).toContain('Cannot find name');
  });

  test('a package with no pin at all must compile — absent means zero', () => {
    const gaps = checkFences({ packages: ['new'], failures: [fail('new', 12)], backlog: {} });
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
  });

  test('at or under the pin holds', () => {
    expect(
      checkFences({ packages: ['ai'], failures: [fail('ai', 9)], backlog: { ai: 1 } }),
    ).toEqual([]);
  });
});

describe('the ratchet only tightens', () => {
  test('a pin higher than what fails is a finding, and the fix is one command', () => {
    const gaps = checkFences({ packages: ['ai'], failures: [], backlog: { ai: 3 } });
    expect(gaps[0]?.kind).toBe('stale');
    expect(fenceGapFindingFor(gaps[0] as never).fix).toBe('bun run scripts/readme-fences.ts --pin');
  });

  test('--pin lowers a count and refuses to raise one', () => {
    const source = [
      'export const README_FENCE_BACKLOG: Readonly<Record<string, number>> = {',
      '  ai: 16,',
      '  render: 5,',
      '  time: 1,',
      '};',
    ].join('\n');
    const next = pinnedSource({ ai: 2, render: 99 }, { ai: 16, render: 5, time: 1 }, source);
    expect(next).toContain('  ai: 2,');
    // measured 99, pinned 5 — the pin stays, because raising it is a reviewed edit
    expect(next).toContain('  render: 5,');
    // measured nothing, so the row goes
    expect(next).not.toContain('time');
  });
});

describe('the rule cannot quietly stop being one', () => {
  test('no fence found anywhere is a failure, never a pass', () => {
    const gaps = checkFences({ packages: [], failures: [], backlog: README_FENCE_BACKLOG });
    expect(gaps[0]?.kind).toBe('unscanned');
    expect(fenceGapFindingFor(gaps[0] as never).code).toBe('X_README_EXAMPLE_UNSCANNED');
  });

  test('a compiler that refused to run is a failure, never a pass', () => {
    // TS18003 "No inputs were found" is exactly how this shipped broken the first time: the base
    // config excludes node_modules and the fixture lives inside it, so tsc typechecked nothing and
    // exited quietly with no diagnostic to attribute.
    const gaps = checkFences({
      packages: ['ai'],
      failures: [],
      backlog: {},
      unscanned: 'error TS18003: No inputs were found in config file',
    });
    expect(gaps[0]?.kind).toBe('unscanned');
  });

  test('a syntax error is recognised, because it suppresses every semantic one', () => {
    expect(isSyntactic({ file: 'a.ts', line: 1, code: 1005, text: '' })).toBe(true);
    expect(isSyntactic({ file: 'a.ts', line: 1, code: 2657, text: '' })).toBe(true);
    expect(isSyntactic({ file: 'a.ts', line: 1, code: 2304, text: '' })).toBe(false);
  });
});

describe('the fence reader and the fixture', () => {
  const markdown = [
    '# Title',
    '',
    '```ts',
    'const one = 1;',
    '```',
    '',
    '```sh',
    'x verify',
    '```',
    '',
    '```tsx',
    '<Button />;',
    '```',
  ].join('\n');

  test('reads ts and tsx, skips every other language, and records the README line', () => {
    const fences = readFences('ui', markdown);
    expect(fences.map((fence) => [fence.lang, fence.readmeLine])).toEqual([
      ['ts', 4],
      ['tsx', 12],
    ]);
  });

  test('one fixture per fence, each its own module', () => {
    const fixtures = buildFixtures(readFences('ui', markdown));
    expect(fixtures.map((one) => one.file)).toEqual(['ui__0.ts', 'ui__1.tsx']);
    expect(fixtures[0]?.text).toContain('export {};');
  });

  test('skipping a fence does not renumber the ones after it', () => {
    // The second pass drops the unparseable blocks; if the names shifted, every diagnostic in it
    // would be attributed to the wrong example.
    const fixtures = buildFixtures(readFences('ui', markdown), (fence) => fence.lang === 'ts');
    expect(fixtures.map((one) => one.file)).toEqual(['ui__1.tsx']);
  });

  test('a diagnostic is attributed to its fence, never dropped', () => {
    const fixtures = buildFixtures(readFences('ui', markdown));
    const diagnostics = parseDiagnostics(
      'node_modules/.cache/x/ui__1.tsx(9,1): error TS2304: Cannot find name.',
    );
    expect(diagnostics).toHaveLength(1);
    expect(fenceOf(fixtures, 'ui__1.tsx')?.readmeLine).toBe(12);
    expect(failuresFrom(fixtures, diagnostics)).toEqual([
      { pkg: 'ui', readmeLine: 12, reason: 'TS2304: Cannot find name.' },
    ]);
  });
});

describe('against this repo', () => {
  test(
    'every package README is compiled and the ratchet holds',
    async () => {
      const measured = await fenceFailures(repoRoot());
      expect(measured.unscanned).toBeUndefined();
      expect(measured.packages.length).toBeGreaterThan(20);
      // Only the hazard direction. A pin that has gone SLACK is the gate's finding, with a
      // one-command fix — asserting it here would make every README improvement a red test
      // before it is a green ratchet.
      const gaps = checkFences({ ...measured, backlog: README_FENCE_BACKLOG });
      expect(gaps.filter((gap) => gap.kind !== 'stale')).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
