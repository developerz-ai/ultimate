// The GPU backend a shot ran on is read from the page, parsed, and never guessed: a WebGPU island
// that rendered nothing on a machine with no adapter is a different bug from one that threw.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { fakeShotDriver } from './browser-launcher-fake-fixture';
import { runShot, SHOT_VERDICT } from './cmd-shot';
import { GPU_PROBE, parseGpuProbe, readShotGpu } from './shot-gpu';
import type { ShotInput } from './shot-verdict';
import { buildVerdict, verdictJson } from './shot-verdict';

const inputFor = (overrides: Partial<ShotInput> = {}): ShotInput => ({
  route: '/app',
  requestedUrl: 'http://localhost:4321/app',
  finalUrl: 'http://localhost:4321/app',
  server: 'booted',
  capturedAt: '2026-11-10T00:00:00.000Z',
  screenshot: 'shot.png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  console: [],
  pageErrors: [],
  pageErrorsDropped: 0,
  network: [],
  networkDropped: 0,
  islands: null,
  ...overrides,
});

/** The probe is a string by contract (`CdpPageLike.evaluate`): its own text runs on a fake navigator. */
const runProbe = async (navigator: unknown): Promise<unknown> =>
  new Function('navigator', `return ${GPU_PROBE};`)(navigator);

describe('unit · the gpu probe states what the page could reach', () => {
  test('no navigator.gpu: the API is absent and nothing is available', async () => {
    expect(parseGpuProbe(await runProbe({}))).toEqual({
      api: false,
      available: false,
      adapter: null,
      fallback: false,
    });
  });

  test('an API that yields no adapter is exposed, and still unavailable', async () => {
    const gpu = { requestAdapter: async () => null };
    expect(parseGpuProbe(await runProbe({ gpu }))).toEqual({
      api: true,
      available: false,
      adapter: null,
      fallback: false,
    });
  });

  test('an adapter is named from its info, and a software fallback says so', async () => {
    const adapter = {
      info: { vendor: 'google', architecture: 'swiftshader', device: '', description: '' },
      isFallbackAdapter: true,
    };
    const gpu = { requestAdapter: async () => adapter };
    expect(parseGpuProbe(await runProbe({ gpu }))).toEqual({
      api: true,
      available: true,
      adapter: 'google swiftshader',
      fallback: true,
    });
  });

  test('a requestAdapter that throws reads as unavailable, never as a crash', async () => {
    const gpu = {
      // The failure is the subject's INPUT — a browser refusing the adapter — so it is rejected,
      // never thrown as though it were this test's verdict.
      requestAdapter: () => Promise.reject(new TypeError('blocked')),
    };
    expect(parseGpuProbe(await runProbe({ gpu }))).toMatchObject({ api: true, available: false });
  });

  test('anything that is not the probe shape parses to null', () => {
    expect(parseGpuProbe(undefined)).toBeNull();
    expect(parseGpuProbe({ available: 'yes' })).toBeNull();
  });

  test('a page that refuses evaluation answers null, not "no gpu"', async () => {
    const page = { evaluate: async () => Promise.reject(new TypeError('target closed')) };
    expect(await readShotGpu(page)).toBeNull();
  });
});

describe('unit · the verdict carries the backend, additively', () => {
  test('gpu rides in the artifact and never gates', () => {
    const gpu = { api: true, available: false, adapter: null, fallback: false };
    const verdict = buildVerdict(inputFor({ gpu }));
    expect(verdict.ok).toBe(true);
    expect(verdictJson(verdict)).toMatchObject({ gpu });
  });

  test('a capture that never probed reports gpu: null', () => {
    expect(verdictJson(buildVerdict(inputFor()))).toMatchObject({ gpu: null });
  });
});

describe('unit · runShot asks the page, and the artifact on disk carries the answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-shot-gpu-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('the adapter the page reported is in verdict.json', async () => {
    const url = 'http://localhost:4321/scene';
    const gpu = { api: true, available: true, adapter: 'nvidia ampere', fallback: false };
    const driver = fakeShotDriver([
      {
        url,
        html: '<!doctype html><canvas></canvas>',
        evaluate: { [GPU_PROBE]: JSON.stringify(gpu) },
      },
    ]);
    const server = {
      url: 'http://localhost:4321',
      origin: 'booted' as const,
      stop: async () => {},
    };
    const artifacts = await runShot({
      route: '/scene',
      outDir: dir,
      driver,
      boot: () => Promise.resolve(server),
      settleMs: 0,
      timeoutMs: 1_000,
      fullPage: true,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    expect(artifacts.verdict.gpu).toEqual(gpu);
    expect(await Bun.file(join(dir, SHOT_VERDICT)).json()).toMatchObject({ gpu });
  });

  // The probe runs after the picture exists, so anything it lets the page do — a redirect while
  // `requestAdapter()` hangs — may not rewrite what the verdict says about that picture.
  test('a page that navigates during the gpu probe does not move the verdict off the picture', async () => {
    const url = 'http://localhost:4321/scene';
    const base = fakeShotDriver([{ url, html: '<!doctype html><canvas></canvas>' }]);
    let current: string | undefined;
    let pictured = '';
    const driver = {
      name: base.name,
      open: async (init: Parameters<typeof base.open>[0]) => {
        const session = await base.open(init);
        const page = session.page;
        return {
          ...session,
          page: {
            ...page,
            url: () => current ?? page.url(),
            screenshot: async (options: Parameters<typeof page.screenshot>[0]) => {
              pictured = page.url();
              return page.screenshot(options);
            },
            evaluate: async (expression: string): Promise<unknown> => {
              if (expression !== GPU_PROBE) return page.evaluate(expression);
              current = 'http://localhost:4321/sign-in';
              return null;
            },
          },
        };
      },
    };
    const server = {
      url: 'http://localhost:4321',
      origin: 'booted' as const,
      stop: async () => {},
    };
    const artifacts = await runShot({
      route: '/scene',
      outDir: join(dir, 'redirect'),
      driver,
      boot: () => Promise.resolve(server),
      settleMs: 0,
      timeoutMs: 1_000,
      fullPage: true,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    expect([artifacts.verdict.finalUrl, artifacts.verdict.redirected]).toEqual([pictured, false]);
  });
});
