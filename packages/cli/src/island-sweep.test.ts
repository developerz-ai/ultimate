// `x shot --all-islands` — the whole app in one run. The properties proved here are the three that
// make a gallery useful rather than merely large: every island is photographed, one island that
// cannot be photographed does not cost the reader the others, and the index that says what each
// picture IS is written whichever form was asked for.
//
// An INJECTED browser and a stub server, exactly as `island-shot.test.ts` does, so the whole path
// is proved on a machine with no Chrome.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove and no synchronous existence check.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import type { ScrapeDriver } from '@ultimat3/scraping';
import { fakeBrowser } from '@ultimat3/scraping';
import type { IslandStatesManifest, IslandViewport } from '@ultimat3/testing';
import { defineIslandStates, islandShotPlan } from '@ultimat3/testing';
import {
  refuseSweepWithIsland,
  refuseSweepWithRoute,
  refuseSweepWithState,
} from './cmd-shot-island';
import { ISLAND_HARNESS_PATH } from './island-harness';
import { readinessProbe } from './island-harness-script';
import type { IslandBrowser } from './island-shot';
import { ISLAND_INDEX, runIslandShot, runIslandSweep } from './island-shot';
import type { IslandReadiness } from './island-verdict';
import type { ShotServer } from './shot-server';

const SERVER_URL = 'http://localhost:4321';

const settings: IslandStatesManifest = defineIslandStates({
  island: 'apps/web/app/settings/settings.island.tsx',
  states: [
    {
      id: 'empty-options',
      title: 'the options read answered nothing',
      note: 'you cannot reach this by clicking, because the options endpoint never answers empty',
      props: { locales: [] },
      themes: ['light'],
    },
  ],
});

const feed: IslandStatesManifest = defineIslandStates({
  island: 'apps/web/app/feed/feed.island.tsx',
  states: [
    { id: 'over-quota', title: 'the tenant is out of quota', props: {}, themes: ['light'] },
    { id: 'read-only', title: 'the workspace is read-only', props: {}, themes: ['light'] },
  ],
});

const ALL = [settings, feed];

const READY: IslandReadiness = {
  harness: true,
  ready: true,
  unstubbed: [],
  attached: true,
  mounted: true,
  failed: null,
  filled: true,
  box: { x: 8, y: 8, width: 420, height: 260 },
  scroll: { x: 0, y: 0 },
  overflow: { x: false, y: false },
  page: { width: 1280, height: 2000 },
};

const PROBE = readinessProbe('[data-x-island]');

/** Every address the plan expands to, minus the ones named — those addresses answer nothing. */
const driverFor = (skip: readonly string[] = []): ScrapeDriver =>
  fakeBrowser(
    islandShotPlan(ALL)
      .filter((target) => !skip.includes(target.file))
      .map((target) => ({
        url: `${SERVER_URL}${ISLAND_HARNESS_PATH}${target.query}`,
        html: '<!doctype html><html><body><div data-x-island="x"></div></body></html>',
        evaluate: { [PROBE]: JSON.stringify(READY) },
      })),
  );

const stubServer = (): ShotServer => ({
  url: SERVER_URL,
  origin: 'reused',
  stop: () => Promise.resolve(),
});

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ultimate-island-sweep-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sweep = (driver: IslandBrowser, out: string) =>
  runIslandSweep({
    manifests: ALL,
    outDir: join(dir, out),
    driver,
    boot: () => Promise.resolve(stubServer()),
    settleMs: 0,
    timeoutMs: 1_000,
    minBytes: 0,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

const oneDriver =
  (driver: ScrapeDriver): IslandBrowser =>
  () =>
    Promise.resolve(driver);

describe('unit · one command, every island', () => {
  test('every state of every island becomes a file, and the index names them all', async () => {
    const artifacts = await sweep(oneDriver(driverFor()), 'all');

    expect(artifacts.verdicts.map((verdict) => verdict.name)).toEqual(['settings', 'feed']);
    for (const target of islandShotPlan(ALL)) {
      expect(existsSync(join(dir, 'all', target.file))).toBe(true);
    }
    expect(artifacts.ok).toBe(true);
    const index = await Bun.file(join(dir, 'all', ISLAND_INDEX)).text();
    // The whole point of the artifact: it says what each picture is, for every island at once.
    expect(index).toContain('settings/empty-options-light.png');
    expect(index).toContain('feed/over-quota-light.png');
    expect(index).toContain('feed/read-only-light.png');
    expect(index).toContain('the tenant is out of quota');
    expect(index).toContain('2 islands, 3 states, 3 pictures');
  });

  test('each island still gets its own verdict.json beside its own pictures', async () => {
    await sweep(oneDriver(driverFor()), 'verdicts');
    for (const name of ['settings', 'feed']) {
      expect(existsSync(join(dir, 'verdicts', name, 'verdict.json'))).toBe(true);
    }
    const feedVerdict: unknown = await Bun.file(
      join(dir, 'verdicts', 'feed', 'verdict.json'),
    ).json();
    // Never the whole plan filed under one island: a verdict that claimed another island's
    // pictures would make `missing` unreadable and the per-island exit code meaningless.
    expect(feedVerdict).toMatchObject({
      name: 'feed',
      expected: ['feed/over-quota-light.png', 'feed/read-only-light.png'],
    });
  });

  /**
   * A state declares its own size and the viewport is a LAUNCH option, so a sweep that built a
   * browser per ISLAND would pay one launch per island for nothing. The memo belongs to the run,
   * not to the island — this fails the moment the sweep asks for a driver once per manifest.
   */
  test('the browser is memoised per viewport ACROSS islands, not per island', async () => {
    const base = driverFor();
    let launches = 0;
    const held = new Map<string, Promise<ScrapeDriver>>();
    const memoised: IslandBrowser = (viewport: IslandViewport) => {
      const key = `${viewport.width}x${viewport.height}`;
      const found = held.get(key);
      if (found !== undefined) return found;
      launches += 1;
      const started = Promise.resolve(base);
      held.set(key, started);
      return started;
    };
    await sweep(memoised, 'memo');

    expect(launches).toBe(1);
  });
});

/**
 * The rule that makes a sweep worth running at all: forty states and one broken component must
 * still hand back thirty-nine pictures plus a named reason for the fortieth.
 */
describe('unit · one island failing does not abort the sweep', () => {
  test('every other picture still lands, the index is still written, the run is still red', async () => {
    const thrown = await sweep(
      oneDriver(driverFor(['settings/empty-options-light.png'])),
      'partial',
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    // The island AFTER the failing one — a loop that aborted would have taken neither.
    expect(existsSync(join(dir, 'partial', 'feed/over-quota-light.png'))).toBe(true);
    expect(existsSync(join(dir, 'partial', 'feed/read-only-light.png'))).toBe(true);
    expect(existsSync(join(dir, 'partial', 'settings/empty-options-light.png'))).toBe(false);
    const index = await Bun.file(join(dir, 'partial', ISLAND_INDEX)).text();
    expect(index).toContain('no picture');
    expect(index).toContain('feed/over-quota-light.png');
  });
});

describe('unit · the index is written for one island too', () => {
  test('a single-island run leaves an index beside its pictures', async () => {
    const artifacts = await runIslandShot({
      manifest: settings,
      outDir: join(dir, 'single'),
      driver: oneDriver(driverFor()),
      boot: () => Promise.resolve(stubServer()),
      settleMs: 0,
      timeoutMs: 1_000,
      minBytes: 0,
    });

    expect(existsSync(artifacts.indexFile)).toBe(true);
    expect(await Bun.file(artifacts.indexFile).text()).toContain('1 island, 1 state, 1 picture');
  });
});

describe('unit · the combinations --all-islands cannot mean, refused by name', () => {
  const thrownBy = (run: () => never): Record<string, unknown> => {
    try {
      run();
    } catch (error) {
      return error as unknown as Record<string, unknown>;
    }
    return expect.unreachable('expected x shot to refuse');
  };

  test('every island and one island are two subjects', () => {
    const error = thrownBy(() => refuseSweepWithIsland('settings'));
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot --all-islands --json',
    ]);
    expect(String(error['cause'])).toContain('--island settings');
  });

  test('every island and a route are two subjects', () => {
    const error = thrownBy(() => refuseSweepWithRoute('/dash'));
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot --all-islands --json',
    ]);
  });

  // A state id belongs to one manifest's vocabulary, so a filter across every island either means
  // nothing or silently means whichever islands happen to share the word.
  test('a state id cannot span every island, and the fix names the form where it can be resolved', () => {
    const error = thrownBy(() => refuseSweepWithState('empty'));
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot --island <name> --state <id> --json',
    ]);
  });
});
