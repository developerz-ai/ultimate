// The failure cases first — a launch under Bun's default and under a literal — then what must never
// be one: a derived deadline, a hook, a helper, prose and a string. Every input is built by hand: a
// test that edits a real test file to prove the rule fires races the gate it guards.

import { describe, expect, test } from 'bun:test';
import {
  checkLaunchDeadlines,
  type LaunchDeadlineGap,
  launchDeadlineFindingFor,
  scanLaunchDeadlines,
} from './launch-deadline';

const PATH = 'packages/scraping/src/a.test.ts';
const scan = (...lines: string[]) => scanLaunchDeadlines(PATH, lines.join('\n'));

describe('scanLaunchDeadlines', () => {
  test('a test awaiting a launch on a deadline of its own is reported, once, by its line', () => {
    const found = scan(
      "test('default', async () => {",
      '  const a = await launchChrome({ executable, timeoutMs: 5_000 });',
      '  const b = await launchChrome({ executable, timeoutMs: 5_000 });',
      '});',
      "test.skipIf(WINDOWS)('literal', async () => {",
      '  await launchAttempt(options);',
      '}, 20_000);',
      'test.each(wires)(',
      "  'each %s',",
      '  async (wire) => {',
      '    browser = await openE2eBrowser();',
      '  },',
      '  150_000,',
      ');',
    );
    expect(found.map((site) => [site.line, site.deadline])).toEqual([
      [1, "Bun's 5000 ms default"],
      [5, '20_000'],
      [8, '150_000'],
    ]);
  });

  test('a deadline derived from the launch budget passes', () => {
    expect(
      scan(
        "test('a', async () => {",
        '  await launchReady({ executable, timeoutMs: 5_000 });',
        '}, LAUNCH_TEST_MS);',
        "test('b', async () => {",
        '  await launchChrome({ executable, timeoutMs: 300, launchTimeoutMs: 300 });',
        '}, launchTestMs(300));',
        "test('c', async () => {",
        '  browser = await openE2eBrowserIfAvailable();',
        '}, E2E_BROWSER_OPEN_MS);',
      ),
    ).toEqual([]);
  });

  test('a hook, a helper, prose and a string are not a test awaiting a launch', () => {
    expect(
      scan(
        'beforeAll(async () => {',
        '  browser = await openE2eBrowser();',
        '}, E2E_BROWSER_OPEN_MS);',
        'const open = () => launchChrome({ executable, timeoutMs: 5_000 });',
        "test('x', async () => {",
        '  // launchChrome({ executable }) is what a slow box times out',
        "  expect(code).toContain('launchChrome(');",
        '});',
      ),
    ).toEqual([]);
  });

  // `findChrome` runs `startsChrome` — `chrome --version` under its own 15 s — per candidate: a cold
  // Chrome on a loaded runner outlived Bun's 5 s default (run 43802046886, unit-1 and unit-3).
  test('a test awaiting a probe for a browser is a test awaiting a browser process', () => {
    const found = scan(
      "test('find', async () => {",
      "  expect(await findChrome({ [CHROME_PATH_ENV]: '' })).toBeDefined();",
      '});',
      "test('probe', async () => {",
      "  expect(await startsChrome(candidate, 'linux')).toBe(true);",
      '}, 30_000);',
    );
    expect(found.map((site) => [site.line, site.deadline])).toEqual([
      [1, "Bun's 5000 ms default"],
      [4, '30_000'],
    ]);
  });

  test('a deadline derived from the probe budget passes', () => {
    expect(
      scan(
        "test('a', async () => {",
        '  await findChrome(env);',
        '}, findChromeTestMs());',
        "test('b', async () => {",
        "  await startsChrome(candidate, 'linux', SHORT_MS);",
        '}, chromeProbeTestMs(1, SHORT_MS));',
      ),
    ).toEqual([]);
  });

  test('a source file is out of scope: only a test has a Bun deadline', () => {
    const source = "test('x', async () => {\n  await launchChrome(options);\n});";
    expect(scanLaunchDeadlines('packages/scraping/src/a.ts', source)).toEqual([]);
  });
});

describe('checkLaunchDeadlines — the ratchet', () => {
  const file = { path: PATH, text: "test('x', async () => {\n  await launchChrome(o);\n});" };

  test('over its pin is an instruction naming the test and the derived deadline', () => {
    const [gap] = checkLaunchDeadlines({ files: [file], pins: {} });
    expect(gap?.kind).toBe('over');
    const finding = launchDeadlineFindingFor(gap as LaunchDeadlineGap);
    expect(finding.code).toBe('X_TEST_LAUNCH_DEADLINE');
    expect(finding.cause).toContain(`${PATH}:1`);
    expect(finding.fix.startsWith('test(name, fn, launchTestMs(launchTimeoutMs))')).toBe(true);
    // A probe's budget is named where to get it, beside the launch's.
    expect(finding.fix).toContain('findChromeTestMs(platform, env)');
  });

  test('a pin above the tree is stale, and an empty corpus is unscanned', () => {
    const [stale] = checkLaunchDeadlines({ files: [file], pins: { scraping: 4 } });
    expect(stale?.kind).toBe('stale');
    expect(launchDeadlineFindingFor(stale as LaunchDeadlineGap).fix).toBe(
      'bun run scripts/launch-deadline.ts --unpin scraping',
    );
    expect(checkLaunchDeadlines({ files: [], pins: {} })[0]?.kind).toBe('unscanned');
  });
});
