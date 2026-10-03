// The failure case first — a fix that opens with a sentence — then the ratchet's two ways of
// lying: a pin above what the tree holds, and a scan that read nothing. The real tree is read last,
// which is what holds this rule on the gate's `unit` step.

import { describe, expect, test } from 'bun:test';
import { fixProseFindingFor, fixProseGaps, fixProseScan, proseFixes } from './fix-prose';
import { fixShape } from './lib/fix-shape';
import { ratchetGaps } from './lib/ratchet';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const PATH = 'packages/demo/src/errors.ts';
const thrown = (fix: string): string =>
  `export const boom = () => new DemoError({ code: 'X_DEMO', cause: 'c', fix: '${fix}' });\n`;

describe('which fix lines are prose', () => {
  test('a fix opening with a sentence is a site, at its own line', () => {
    const sites = proseFixes(PATH, `\n${thrown('add a row for X_DEMO to the wiki page')}`);
    expect(sites).toEqual([{ path: PATH, line: 2, fix: 'add a row for X_DEMO to the wiki page' }]);
  });

  test('a command, a code shape, and a fix only known at run time are not', () => {
    expect(proseFixes(PATH, thrown('x db migrate --json'))).toEqual([]);
    expect(proseFixes(PATH, thrown('defineAuth({ session })'))).toEqual([]);
    expect(proseFixes(PATH, 'const e = { fix: init.fix };\n')).toEqual([]);
  });
});

describe('the ratchet', () => {
  const site = { path: PATH, line: 1, fix: 'add a row' };

  test('a package over its pin is X_FIX_PROSE, and its fix is a command', () => {
    const [gap] = ratchetGaps([site, site], { demo: 1 }, true);
    const finding = fixProseFindingFor(gap ?? expect.unreachable('no gap'));
    expect(finding.code).toBe('X_FIX_PROSE');
    expect(finding.at).toBe(`${PATH}:1`);
    expect(fixShape(finding.fix)).toBe('command');
  });

  test('a pin above the tree is stale, and its fix is the unpin command', () => {
    const [gap] = ratchetGaps([site], { demo: 3 }, true);
    const finding = fixProseFindingFor(gap ?? expect.unreachable('no gap'));
    expect(finding.code).toBe('X_FIX_PROSE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/fix-prose.ts --unpin demo');
  });

  test('a blank reason waives nothing, and a scan that read nothing is never clean', () => {
    const blank = ratchetGaps([site], { demo: { count: 1, reason: ' ' } }, true);
    expect(blank.map((gap) => fixProseFindingFor(gap).code)).toContain(
      'X_FIX_PROSE_PIN_UNEXPLAINED',
    );
    const [unscanned] = ratchetGaps([], {}, false);
    expect(fixProseFindingFor(unscanned ?? expect.unreachable('no gap')).code).toBe(
      'X_FIX_PROSE_UNSCANNED',
    );
  });

  test('every fix this rule writes opens with a command — it is held to itself', () => {
    const gaps = [
      ...ratchetGaps([site, site], { demo: 1 }, true),
      ...ratchetGaps([site], { demo: 3 }, true),
      ...ratchetGaps([site], { demo: { count: 1, reason: '' } }, true),
      ...ratchetGaps([], {}, false),
    ];
    for (const gap of gaps) expect(fixShape(fixProseFindingFor(gap).fix)).toBe('command');
  });
});

describe('the real tree', () => {
  test(
    'every package is at or under its pin, over a scan that read the whole fix corpus',
    async () => {
      const root = repoRoot();
      const scan = await fixProseScan(root);
      expect(scan.read).toBeGreaterThan(1000);
      expect(scan.sites.length).toBeGreaterThan(0);
      expect((await fixProseGaps(root)).map(fixProseFindingFor)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
