// `x design research` without a browser: an injected fake driver answers the in-page pass, a sealed
// resolver answers DNS, so every artefact, the refusals and the `--follow` cap are proved offline.
// The real-Chrome half (interception, the fixture server) is `cmd-design.e2e.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { defineTheme } from '@ultimat3/ui';
import { fakeShotDriver } from './browser-launcher-fake-fixture';
import type { ShotDriver } from './browser-launcher-port';
import { designCommand, runDesignResearch } from './cmd-design';
import { referenceShotName } from './cmd-design-paths';
import { designSpec } from './cmd-design-spec';
import type { CommandContext } from './command';
import { DESIGN_PASS } from './design-extract-script';
import { parseArgs } from './parse';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-design-'));
  dirs.push(dir);
  return dir;
};

const publicDns = async (): Promise<readonly string[]> => ['93.184.216.34'];

const pass = (links: readonly string[]) =>
  JSON.stringify({
    viewport: { width: 390, height: 844 },
    colors: [
      { rgb: [250, 250, 249], alpha: 1, use: 'background', weight: 900000 },
      { rgb: [24, 24, 27], alpha: 1, use: 'text', weight: 4000 },
      { rgb: [37, 99, 235], alpha: 1, use: 'background', weight: 30000 },
    ],
    fonts: [{ family: 'Inter', sizePx: 16, weight: 400, uses: 100 }],
    spacing: [{ px: 16, count: 4 }],
    radii: [{ px: 6, count: 9 }],
    shadows: [],
    backdrop: { count: 0, blurPx: [] },
    canvases: 0,
    motion: [
      {
        kind: 'animation',
        trigger: 'enter',
        durationMs: 300,
        delayMs: 0,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        iterations: 1,
        properties: ['opacity'],
      },
    ],
    links,
  });

const site = (pages: readonly (readonly [string, readonly string[]])[]): ShotDriver =>
  fakeShotDriver(
    pages.map(([url, links]) => ({
      url,
      html: '<p>x</p>',
      evaluate: { [DESIGN_PASS]: pass(links) },
    })),
  );

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, [designSpec]),
  cwd,
  env: {},
  runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  bunVersion: Bun.version,
});

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return expect.unreachable('the run succeeded');
};

describe('runDesignResearch', () => {
  test('writes the four shots and the four JSON artefacts, and the proposal is one defineTheme accepts', async () => {
    const out = scratch();
    const [reference] = await runDesignResearch({
      urls: ['https://example.com/'],
      outDir: out,
      env: {},
      resolve: publicDns,
      driver: async () => site([['https://example.com/', []]]),
    });
    const dir = join(out, 'example-com');
    expect(reference?.dir).toBe(dir);
    for (const name of [
      referenceShotName(390, 'light'),
      referenceShotName(390, 'dark'),
      referenceShotName(1440, 'light'),
      referenceShotName(1440, 'dark'),
      'reference.json',
      'tokens.proposal.json',
      'motion-map.json',
      'sources.json',
    ]) {
      expect(await Bun.file(join(dir, name)).exists()).toBe(true);
    }
    const proposal: unknown = await Bun.file(join(dir, 'tokens.proposal.json')).json();
    expect(proposal).toMatchObject({
      colors: { light: { bg: '250 250 249' } },
      radius: { sm: '6px' },
    });
    expect(() => defineTheme(proposal as Parameters<typeof defineTheme>[0])).not.toThrow();
    expect(reference?.validated).toBe(true);
    const sources: unknown = await Bun.file(join(dir, 'sources.json')).json();
    expect(sources).toMatchObject({ posture: 'ideas-only', source: null });
    const map: unknown = await Bun.file(join(dir, 'motion-map.json')).json();
    expect(map).toMatchObject({ entries: [{ module: '@ultimat3/ui/motion', name: 'animate' }] });
  });

  test('--follow visits at most n same-origin links, each with its own artefacts', async () => {
    const pages = [
      [
        'https://example.com/',
        [
          'https://example.com/a',
          'https://example.com/b',
          'https://example.com/c',
          'https://elsewhere.com/',
        ],
      ],
      ['https://example.com/a', []],
      ['https://example.com/b', []],
      ['https://example.com/c', []],
    ] as const;
    const references = await runDesignResearch({
      urls: ['https://example.com/'],
      outDir: scratch(),
      env: {},
      follow: 2,
      resolve: publicDns,
      driver: async () => site(pages),
    });
    expect(references.map((r) => [r.url, r.followedFrom])).toEqual([
      ['https://example.com/', null],
      ['https://example.com/a', 'https://example.com/'],
      ['https://example.com/b', 'https://example.com/'],
    ]);
  });

  test('a loopback reference is refused before any browser opens', async () => {
    expect(
      await codeOf(() =>
        runDesignResearch({
          urls: ['http://127.0.0.1:9/'],
          outDir: scratch(),
          env: {},
          resolve: publicDns,
          driver: () => expect.unreachable('a browser was opened for a refused URL'),
        }),
      ),
    ).toBe('X_DESIGN_URL_REFUSED');
  });

  test('a navigation that fails is X_DESIGN_REFERENCE_UNREACHABLE', async () => {
    expect(
      await codeOf(() =>
        runDesignResearch({
          urls: ['https://example.com/missing'],
          outDir: scratch(),
          env: {},
          resolve: publicDns,
          driver: async () => site([['https://example.com/', []]]),
        }),
      ),
    ).toBe('X_DESIGN_REFERENCE_UNREACHABLE');
  });
});

describe('x design research', () => {
  test('--list names every default catalogue with its posture', async () => {
    const result = await designCommand.run(
      ctxFor(['design', 'research', '--list', '--json'], scratch()),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ name: 'React Bits', posture: 'ideas-only' }),
      ]),
    });
  });

  test('no URL, and --list beside a URL, are X_CLI_BAD_FLAG', async () => {
    expect(await codeOf(() => designCommand.run(ctxFor(['design', 'research'], scratch())))).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(
      await codeOf(() =>
        designCommand.run(
          ctxFor(['design', 'research', 'https://example.com/', '--list'], scratch()),
        ),
      ),
    ).toBe('X_CLI_BAD_FLAG');
  });

  test('the default path refuses loopback — there is no flag that admits it', async () => {
    expect(
      await codeOf(() =>
        designCommand.run(ctxFor(['design', 'research', 'http://localhost:3000/'], scratch())),
      ),
    ).toBe('X_DESIGN_URL_REFUSED');
    expect(
      await codeOf(() =>
        designCommand.run(
          ctxFor(
            ['design', 'research', 'https://example.com/', '--allow-hosts', '127.0.0.1'],
            scratch(),
          ),
        ),
      ),
    ).toBe('X_DESIGN_URL_REFUSED');
  });
});
