// `x shot --island` drives a real browser, so every rule it holds is proved here through an
// INJECTED one: `fakeBrowser()` plus a stub server, exactly as `cmd-shot.test.ts` does. The rule
// that matters most is the last describe — a run that produces no picture must not exit 0, and
// that is asserted against the expansion computed before any browser existed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';
import { fakeBrowser } from '@ultimat3/scraping';
import type { IslandStatesManifest } from '@ultimat3/testing';
import { defineIslandStates, islandShotTargets } from '@ultimat3/testing';
import { readStateFlag, refuseRouteWithIsland } from './cmd-shot-island';
import { ISLAND_HARNESS_PATH } from './island-harness';
import { readinessProbe } from './island-harness-script';
import type { IslandBrowser } from './island-shot';
import { ISLAND_VERDICT, missingShots, photographFault, runIslandShot } from './island-shot';
import type { IslandReadiness } from './island-verdict';
import type { ShotServer } from './shot-server';

const SERVER_URL = 'http://localhost:4321';
const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const manifest: IslandStatesManifest = defineIslandStates({
  island: ISLAND,
  states: [
    { id: 'empty-options', title: 'the options read answered nothing', props: { locales: [] } },
    {
      id: 'save-failed',
      title: 'the save came back 500',
      props: { status: 'failed' },
      themes: ['light'],
    },
  ],
});

const READY: IslandReadiness = {
  harness: true,
  ready: true,
  unstubbed: [],
  attached: true,
  mounted: true,
  failed: null,
  filled: true,
  box: { x: 8, y: 8, width: 420, height: 260 },
};

const PROBE = readinessProbe('[data-x-island]');

/** Every address this manifest expands to, answered with the same clean readiness. */
const cleanDriver = (answer: IslandReadiness = READY): ScrapeDriver =>
  fakeBrowser(
    islandShotTargets(manifest).map((target) => ({
      url: `${SERVER_URL}${ISLAND_HARNESS_PATH}${target.query}`,
      html: '<!doctype html><html><body><div data-x-island="settings"></div></body></html>',
      evaluate: { [PROBE]: JSON.stringify(answer) },
    })),
  );

const browserOf =
  (driver: ScrapeDriver): IslandBrowser =>
  () =>
    Promise.resolve(driver);

const stubServer = (): ShotServer => ({
  url: SERVER_URL,
  origin: 'reused',
  stop: () => Promise.resolve(),
});

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ultimate-island-shot-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (driver: ScrapeDriver, out: string, state?: string) =>
  runIslandShot({
    manifest,
    ...(state === undefined ? {} : { state }),
    outDir: join(dir, out),
    driver: browserOf(driver),
    boot: () => Promise.resolve(stubServer()),
    settleMs: 0,
    timeoutMs: 1_000,
    // The fake driver answers an 8-byte PNG signature; the floor is proved in its own case below.
    minBytes: 0,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

describe('unit · every declared state becomes a file', () => {
  test('one picture per state per theme, at the path the vocabulary already named', async () => {
    const artifacts = await run(cleanDriver(), 'clean');

    // Three, not four: `save-failed` declares `themes: ['light']`, so the expansion is the
    // manifest's own answer and never a count this command decided.
    expect(artifacts.verdict.expected.map((target) => target.file)).toEqual([
      'settings/empty-options-light.png',
      'settings/empty-options-dark.png',
      'settings/save-failed-light.png',
    ]);
    for (const target of artifacts.verdict.expected) {
      expect(existsSync(join(dir, 'clean', target.file))).toBe(true);
    }
    expect(artifacts.verdict.ok).toBe(true);
    expect(artifacts.verdict.missing).toEqual([]);
    expect(existsSync(artifacts.verdictFile)).toBe(true);
    expect(artifacts.verdictFile.endsWith(join('settings', ISLAND_VERDICT))).toBe(true);
  });

  test('--state narrows the expansion, so only that state is owed a picture', async () => {
    const artifacts = await run(cleanDriver(), 'one', 'save-failed');

    expect(artifacts.verdict.expected.map((target) => target.state)).toEqual(['save-failed']);
    expect(artifacts.verdict.shots).toHaveLength(1);
  });
});

/**
 * The single most important behaviour in this command, and the reason the expansion is computed
 * before a browser exists: a capture loop that swallowed every failure would otherwise report a
 * clean run with no pictures in it.
 */
describe('unit · a run that produced nothing cannot exit 0', () => {
  test('a driver that refuses every address leaves the run red and names every absent file', async () => {
    // No answers at all: `fakeBrowser` has no page for any address, so every capture throws.
    const artifacts = await run(fakeBrowser([]), 'none').catch((error: unknown) => error);

    expect(artifacts).toBeInstanceOf(Error);
    // The verdict is written before the refusal is thrown, so the artifact survives the failure.
    const verdict: unknown = await Bun.file(join(dir, 'none', 'settings', ISLAND_VERDICT)).json();
    expect(verdict).toMatchObject({ ok: false, missing: expect.any(Array) });
  });

  test('missingShots reads the expansion, never the loop', async () => {
    const missing = await missingShots(join(dir, 'never-written'), islandShotTargets(manifest));
    expect(missing).toEqual([
      'settings/empty-options-light.png',
      'settings/empty-options-dark.png',
      'settings/save-failed-light.png',
    ]);
  });
});

describe('unit · an unstubbed request fails the run rather than being photographed', () => {
  test('the refusal names the method and path, and no picture is written', async () => {
    const leaked: IslandReadiness = { ...READY, unstubbed: ['GET /api/settings'] };
    const thrown = await run(cleanDriver(leaked), 'leaky').catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: 'X_SHOT_ISLAND_UNSTUBBED_REQUEST' });
    expect((thrown as { cause: string }).cause).toContain('GET /api/settings');
    // The fix line is the edit, and it carries the request verbatim so it is a paste.
    expect((thrown as { fix: string }).fix).toContain("match: 'GET /api/settings'");
    expect(existsSync(join(dir, 'leaky', 'settings/empty-options-light.png'))).toBe(false);
  });
});

describe('unit · the assertions that must hold before a shutter opens', () => {
  const target = islandShotTargets(manifest)[0] as ReturnType<typeof islandShotTargets>[number];

  test('a clean readiness is the only answer that opens one', () => {
    expect(photographFault(target, READY)).toBeUndefined();
  });

  // Each of these photographs a plausible-looking image of the wrong thing, which is worse than
  // no image: a reviewer cannot tell any of them from a component that renders exactly this.
  test('every silence a picture would have hidden is refused by name', () => {
    expect(photographFault(target, null)?.reason).toContain('no readiness probe');
    expect(photographFault(target, { ...READY, harness: false })?.reason).toContain(
      'not the shot harness',
    );
    expect(photographFault(target, { ...READY, attached: false })?.reason).toContain(
      'no [data-x-island]',
    );
    expect(photographFault(target, { ...READY, failed: 'TypeError: x' })?.reason).toContain(
      'REJECTED',
    );
    expect(photographFault(target, { ...READY, mounted: false })?.reason).toContain(
      'did not finish mounting',
    );
    expect(photographFault(target, { ...READY, ready: false })?.reason).toContain(
      'never went quiet',
    );
    expect(
      photographFault(target, { ...READY, box: { x: 0, y: 0, width: 0, height: 12 } })?.reason,
    ).toContain('bounding box');
    expect(photographFault(target, { ...READY, filled: false })?.reason).toContain(
      'rendered nothing',
    );
  });

  test('every fault names a fix, because a refusal with no repair is a dead end', () => {
    for (const seen of [null, { ...READY, attached: false }, { ...READY, filled: false }]) {
      expect(photographFault(target, seen)?.fix).not.toBe('');
    }
  });
});

describe('unit · the byte floor is a backstop against an answer that is not an image', () => {
  test('a driver that hands back a PNG signature and nothing else is refused', async () => {
    const thrown = await runIslandShot({
      manifest,
      state: 'save-failed',
      outDir: join(dir, 'tiny'),
      driver: browserOf(cleanDriver()),
      boot: () => Promise.resolve(stubServer()),
      settleMs: 0,
      timeoutMs: 1_000,
    }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: 'X_SHOT_ISLAND_UNPHOTOGRAPHABLE' });
    expect((thrown as { cause: string }).cause).toContain('not an image');
  });
});

describe('unit · the two flag rules, refused before anything boots', () => {
  test('--island and a route positional are one command with two subjects', () => {
    expect(() => refuseRouteWithIsland('/dash', 'settings')).toThrow();
    try {
      refuseRouteWithIsland('/dash', 'settings');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
      expect((error as { fix: string }).fix).toBe('x shot --island settings --json');
    }
  });

  test('--state naming no declared state lists the ones that exist', () => {
    expect(readStateFlag(manifest, 'save-failed')).toBe('save-failed');
    expect(readStateFlag(manifest, undefined)).toBeUndefined();
    try {
      readStateFlag(manifest, 'over-quota');
      expect.unreachable('a state the manifest does not declare must be refused');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
      expect((error as { cause: string }).cause).toContain('empty-options');
    }
  });
});

/** A session per target, and it is not an optimisation to collapse: see `captureOne`'s header. */
describe('unit · one session per picture, so a console error lands on the right state', () => {
  test('the driver is opened once per address', async () => {
    const base = cleanDriver();
    let opened = 0;
    const counting: ScrapeDriver = {
      name: base.name,
      open: (init): Promise<ScrapeSession> => {
        opened += 1;
        return base.open(init);
      },
    };
    await runIslandShot({
      manifest,
      outDir: join(dir, 'sessions'),
      driver: browserOf(counting),
      boot: () => Promise.resolve(stubServer()),
      settleMs: 0,
      timeoutMs: 1_000,
      minBytes: 0,
    });
    expect(opened).toBe(3);
  });
});

/**
 * The byte floor, when it is not a number. `bytes.byteLength < NaN` is false for every picture, so
 * an unchecked floor is not a lower floor — it is no floor at all, and this backstop is the last
 * assertion between a run and "produced nothing and exited 0", which is the one outcome the file's
 * own header says a reader cannot tell from success.
 *
 * Refused before `boot()`, so a typo costs neither an embedded Postgres nor a browser launch —
 * the same rule the expansion above it already follows.
 */
describe('unit · a byte floor that is not a number is not a floor', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  test('a non-finite minBytes is refused, and nothing is booted', async () => {
    for (const minBytes of NOT_A_BOUND) {
      let booted = 0;
      await expect(
        runIslandShot({
          manifest,
          outDir: join(dir, 'unbounded'),
          driver: browserOf(cleanDriver()),
          boot: () => {
            booted += 1;
            return Promise.resolve(stubServer());
          },
          settleMs: 0,
          timeoutMs: 1_000,
          minBytes,
        }),
      ).rejects.toThrow('X_INVARIANT');
      expect(booted).toBe(0);
    }
  });

  // 0 is "no floor", and it is what every case above passes: the fake driver answers an 8-byte
  // PNG signature, so refusing 0 would refuse this suite's own subject.
  test('a minBytes of 0 is still accepted, because it is the seam a fake driver needs', async () => {
    const artifacts = await run(cleanDriver(), 'floor-zero');
    expect(artifacts.verdict.ok).toBe(true);
  });
});
