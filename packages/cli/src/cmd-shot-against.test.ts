// `x shot --against`: which reference shot each route shot is paired with, what a missing pair is,
// and that the comparison lands in verdict.json without changing the verdict. Through an injected
// shoot, so no Chrome and no dev server.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { encodeImage, isUltimateError } from '@ultimat3/core';
import { referenceShotName } from './cmd-design-paths';
import type { ShotRun } from './cmd-shot';
import { planAgainst, runAgainst } from './cmd-shot-against';
import type { ShotServer } from './shot-server';
import type { ShotArtifacts, ShotVerdict } from './shot-verdict';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-against-'));
  dirs.push(dir);
  return dir;
};

const png = (rgba: readonly number[], width = 3, height = 2): Uint8Array => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set(rgba, at);
  return encodeImage({ width, height, pixels });
};

const missing = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return expect.unreachable('planAgainst accepted a reference with no matching shot');
};

/** A reference directory holding exactly the named shots. */
const reference = async (shots: readonly (readonly [number, 'light' | 'dark'])[]) => {
  const dir = join(scratch(), 'example-com');
  mkdirSync(dir, { recursive: true });
  for (const [width, scheme] of shots) {
    await Bun.write(join(dir, referenceShotName(width, scheme)), png([10, 20, 30, 255]));
  }
  return dir;
};

describe('planAgainst', () => {
  test('a reference directory pairs every shot it holds, by width and scheme', async () => {
    const dir = await reference([
      [390, 'light'],
      [1440, 'dark'],
    ]);
    const plan = planAgainst({ reference: dir });
    expect(plan.map((pair) => [pair.viewport.width, pair.scheme])).toEqual([
      [390, 'light'],
      [1440, 'dark'],
    ]);
  });

  test('a viewport or theme with no reference shot of its own is X_SHOT_AGAINST_MISSING', async () => {
    const dir = await reference([[390, 'light']]);
    expect(missing(() => planAgainst({ reference: dir, theme: 'dark' }))).toBe(
      'X_SHOT_AGAINST_MISSING',
    );
    expect(
      missing(() => planAgainst({ reference: dir, viewports: [{ width: 800, height: 600 }] })),
    ).toBe('X_SHOT_AGAINST_MISSING');
  });

  test('a directory with no shot, and a path that is not there, are X_SHOT_AGAINST_MISSING', async () => {
    const empty = await reference([]);
    expect(missing(() => planAgainst({ reference: empty }))).toBe('X_SHOT_AGAINST_MISSING');
    expect(missing(() => planAgainst({ reference: join(empty, 'nope.png') }))).toBe(
      'X_SHOT_AGAINST_MISSING',
    );
  });

  test('a single PNG is one pair, at the viewport and theme asked for', async () => {
    const dir = scratch();
    const file = join(dir, 'mock.png');
    await Bun.write(file, png([1, 2, 3, 255]));
    const [pair] = planAgainst({
      reference: file,
      viewports: [{ width: 390, height: 844 }],
      theme: 'dark',
    });
    expect(pair).toEqual({
      viewport: { width: 390, height: 844 },
      scheme: 'dark',
      reference: file,
    });
  });
});

describe('runAgainst', () => {
  const server: ShotServer = {
    url: 'http://localhost:1/',
    origin: 'booted',
    stop: () => Promise.resolve(),
  };

  /** A shoot that writes the given picture and a verdict, as `runShot` does. */
  const shootWith =
    (bytes: Uint8Array, ok: boolean, seen: ShotRun[]) =>
    async (run: ShotRun): Promise<ShotArtifacts> => {
      seen.push(run);
      mkdirSync(run.outDir, { recursive: true });
      const image = join(run.outDir, 'shot.png');
      const verdictFile = join(run.outDir, 'verdict.json');
      await Bun.write(image, bytes);
      await Bun.write(verdictFile, JSON.stringify({ ok, route: run.route }));
      return { verdict: { ok } as ShotVerdict, image, verdictFile };
    };

  test('an identical capture is similarity 1, written into verdict.json beside a diff', async () => {
    const dir = await reference([[390, 'light']]);
    const seen: ShotRun[] = [];
    const result = await runAgainst({
      pairs: planAgainst({ reference: dir }),
      outDir: join(scratch(), 'out'),
      boot: () => Promise.resolve(server),
      shoot: shootWith(png([10, 20, 30, 255]), true, seen),
      base: {
        route: '/',
        driver: { name: 'x', open: () => expect.unreachable() },
        settleMs: 0,
        timeoutMs: 1,
        fullPage: true,
      },
    });
    expect(seen.map((run) => [run.viewport?.width, run.colorScheme])).toEqual([[390, 'light']]);
    const [shot] = result.shots;
    expect(shot?.similarity).toBe(1);
    const verdict: unknown = await Bun.file(shot?.verdictFile ?? '').json();
    expect(verdict).toMatchObject({ ok: true, against: { similarity: 1 } });
    expect(await Bun.file(shot?.diff ?? '').exists()).toBe(true);
    expect(shot?.diff.endsWith('diff-390-light.png')).toBe(true);
  });

  test('a different capture lowers similarity and never changes the verdict', async () => {
    const dir = await reference([[390, 'light']]);
    const result = await runAgainst({
      pairs: planAgainst({ reference: dir }),
      outDir: join(scratch(), 'out'),
      boot: () => Promise.resolve(server),
      shoot: shootWith(png([250, 250, 250, 255]), true, []),
      base: {
        route: '/',
        driver: { name: 'x', open: () => expect.unreachable() },
        settleMs: 0,
        timeoutMs: 1,
        fullPage: true,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.shots[0]?.similarity).toBe(0);
  });
});
