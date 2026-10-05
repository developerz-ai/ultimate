// `x shot --viewport`: the flag read into sizes (every malformed spelling refused by name before
// anything boots), and a route photographed once per size into `<out>/<w>x<h>/` over ONE server.
// No Chrome: `fakeShotDriver()`, with every session's init recorded.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch out dir; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { fakeShotDriver } from './browser-launcher-fake';
import type { ShotDriver, ShotSessionInit } from './browser-launcher-port';
import { runShot, type ShotServer } from './cmd-shot';
import { msg } from './messages';
import type { ShotArtifacts } from './shot-verdict';
import { ISLAND_PROBE, shotSummary } from './shot-verdict';
import { parseViewports, runShotViewports, VIEWPORT_MAX, viewportDir } from './shot-viewport';

const SERVER_URL = 'http://localhost:4321';
const scratch = mkdtempSync(join(tmpdir(), 'x-shot-viewport-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CLEAN = JSON.stringify({
  declared: 0,
  booted: 0,
  mounted: 0,
  failed: 0,
  byStrategy: {},
  failures: [],
});

const refusal = (raw: string): unknown => {
  try {
    return parseViewports(raw);
  } catch (error) {
    return error;
  }
};

describe('parseViewports', () => {
  test('absent is no override; a comma list is every size, in the order typed', () => {
    expect(parseViewports(undefined)).toBeUndefined();
    expect(parseViewports('390x844,1440x900')).toEqual([
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]);
    expect(parseViewports(' 820x1180 ')).toEqual([{ width: 820, height: 1180 }]);
    expect(parseViewports('390X844, 1440x900')).toEqual([
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]);
  });

  test.each([
    '',
    ',',
    '390',
    '390x',
    'x844',
    '390x844,',
    '390*844',
    '390×844',
    '-390x844',
    '390.5x844',
    '0x844',
    '390x0',
    '0x10x844',
    `${VIEWPORT_MAX + 1}x900`,
    '1e3x900',
  ])('%p is X_CLI_BAD_FLAG naming the flag', (raw) => {
    const thrown = refusal(raw);
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((thrown as { cause: string }).cause).toContain('--viewport');
    expect((thrown as { fix: string }).fix).toBe('x shot / --viewport 390x844,1440x900 --json');
  });

  test('the same size twice is refused: the second picture would overwrite the first', () => {
    expect(refusal('390x844,1440x900,0390x844')).toBeUltimateError('X_CLI_BAD_FLAG');
  });

  test('a size is its own directory name', () => {
    expect(viewportDir({ width: 390, height: 844 })).toBe('390x844');
  });
});

describe('runShotViewports', () => {
  test('one server, one capture per size, each pinned and in <out>/<w>x<h>/', async () => {
    const base = fakeShotDriver([
      {
        url: `${SERVER_URL}/pricing`,
        html: '<!doctype html><html><body>page</body></html>',
        evaluate: { [ISLAND_PROBE]: CLEAN },
      },
    ]);
    const opened: ShotSessionInit[] = [];
    const driver: ShotDriver = {
      name: base.name,
      open: (init) => {
        opened.push(init);
        return base.open(init);
      },
    };
    let boots = 0;
    let stops = 0;
    const boot = (): Promise<ShotServer> => {
      boots += 1;
      return Promise.resolve({
        url: SERVER_URL,
        origin: 'booted',
        stop: () => {
          stops += 1;
          return Promise.resolve();
        },
      });
    };
    const viewports = parseViewports('390x844,1440x900') ?? [];
    const outDir = join(scratch, 'pricing');

    const result = await runShotViewports({
      viewports,
      outDir,
      boot,
      shoot: runShot,
      base: {
        route: '/pricing',
        driver,
        settleMs: 0,
        timeoutMs: 1_000,
        fullPage: true,
        acceptLanguage: 'en',
      },
    });

    expect(result.ok).toBe(true);
    expect(boots).toBe(1);
    expect(stops).toBe(1);
    expect(opened.map((init) => init.viewport)).toEqual([...viewports]);
    expect(opened.map((init) => init.headers?.['accept-language'])).toEqual(['en', 'en']);
    for (const dir of ['390x844', '1440x900']) {
      expect(await Bun.file(join(outDir, dir, 'shot.png')).exists()).toBe(true);
      expect(await Bun.file(join(outDir, dir, 'verdict.json')).exists()).toBe(true);
    }
    const shots = (result.data as { shots: readonly { width: number; image: string }[] }).shots;
    expect(shots.map((shot) => shot.width)).toEqual([390, 1440]);
    expect(shots[1]?.image).toBe(join(outDir, '1440x900', 'shot.png'));
    expect(result.lines?.[0]).toStartWith('390x844');
  });

  test('a failed size fails the run, and the summary names that size', async () => {
    // A 500 document fails the verdict of every size it is photographed at.
    const driver = fakeShotDriver([
      {
        url: `${SERVER_URL}/missing`,
        status: 500,
        html: '<!doctype html><html><body>boom</body></html>',
        evaluate: { [ISLAND_PROBE]: CLEAN },
      },
    ]);
    const result = await runShotViewports({
      viewports: [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ],
      outDir: join(scratch, 'missing'),
      boot: () =>
        Promise.resolve({ url: SERVER_URL, origin: 'booted', stop: () => Promise.resolve() }),
      shoot: runShot,
      base: { route: '/missing', driver, settleMs: 0, timeoutMs: 1_000, fullPage: true },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toStartWith('390x844: ');
  });

  test('the summary and each size line are catalog messages, never inline text', async () => {
    const driver = fakeShotDriver([
      { url: `${SERVER_URL}/`, html: '<html></html>', evaluate: { [ISLAND_PROBE]: CLEAN } },
    ]);
    const taken: ShotArtifacts[] = [];
    const result = await runShotViewports({
      viewports: [{ width: 390, height: 844 }],
      outDir: join(scratch, 'catalog'),
      boot: () =>
        Promise.resolve({ url: SERVER_URL, origin: 'booted', stop: () => Promise.resolve() }),
      shoot: async (run) => {
        const artifacts = await runShot(run);
        taken.push(artifacts);
        return artifacts;
      },
      base: { route: '/', driver, settleMs: 0, timeoutMs: 1_000, fullPage: true },
    });
    const [shot] = taken;
    if (shot === undefined) return expect.unreachable('no size was photographed');
    const summary = shotSummary(shot.verdict);
    expect(result.summary).toBe(msg('cli.shot.viewport.summary', { size: '390x844', summary }));
    expect(result.lines?.[0]).toBe(msg('cli.shot.viewport.line', { size: '390x844', summary }));
    // A catalog miss renders `⟦key⟧`: both keys must exist, or the equalities above prove nothing.
    expect(`${result.summary} ${result.lines?.[0] ?? ''}`).not.toContain('⟦');
  });
});
