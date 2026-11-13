// `x cache`: `bust` and `clear` hand the tags to the app's own tiers (a fake here, the boot in the
// shipped command) and close them, a tier's failure is a coded finding, an in-process bus is said
// out loud, and `graph` reads the manifest. The real boot is `startServices`' own suite's.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in this synchronous fixture helper.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { InvalidationReport } from '@ultimat3/cache';
import { declareTags, isolateDeclaredTags } from '@ultimat3/cache';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { REQUIRED_BUN } from './app-root';
import { type CacheHandle, cacheCommandOver, openAppCacheWith } from './cmd-cache';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import type { SchemaMode } from './runtime-queue';
import type { RunningServices } from './runtime-services';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const appRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-cache-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.1.0"}\n');
  return dir;
};

const ctxFor = (cwd: string, argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const report = (tags: readonly string[], errors: InvalidationReport['errors'] = []) =>
  ({
    tags: [...tags],
    tiers: [{ tier: 'redis', keys: ['k1', 'k2'] }],
    isr: [],
    cdn: [],
    liveQueries: [],
    durationMs: 1,
    errors,
  }) as InvalidationReport;

const fake = (options: { peers: boolean; errors?: InvalidationReport['errors'] }) => {
  const asked: (readonly string[])[] = [];
  let closed = 0;
  const handle: CacheHandle = {
    invalidate: async (tags) => {
      asked.push(tags);
      return report(tags, options.errors);
    },
    reachesPeers: options.peers,
    bus: options.peers ? 'nats' : 'in-process',
    close: async () => {
      closed += 1;
    },
  };
  const command = cacheCommandOver(async () => handle);
  return { command, asked, closed: () => closed };
};

describe('unit · x cache bust and clear', () => {
  test('bust hands the one tag to the tiers, reports them, and closes the boot', async () => {
    const { command, asked, closed } = fake({ peers: true });
    const result = await command.run(ctxFor(appRoot(), ['cache', 'bust', 'post:42']));
    expect(asked).toEqual([['post:42']]);
    expect(closed()).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      tags: ['post:42'],
      tiers: [{ tier: 'redis', keys: 2 }],
      bus: 'nats',
      reachesPeers: true,
    });
  });

  test('an in-process bus is said in the summary: no running server heard it', async () => {
    const { command } = fake({ peers: false });
    const result = await command.run(ctxFor(appRoot(), ['cache', 'bust', 'post']));
    expect(result.summary).toContain('this process only');
    expect(result.data).toMatchObject({ reachesPeers: false });
  });

  test('a tier that failed the bust is a coded finding, and the run is red', async () => {
    const { command } = fake({ peers: true, errors: [{ tier: 'broadcast', message: 'refused' }] });
    const result = await command.run(ctxFor(appRoot(), ['cache', 'bust', 'post']));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_CACHE_DRIVER_UNAVAILABLE']);
    expect(result.findings?.[0]?.fix.startsWith('x cache bust post --json')).toBe(true);
  });

  test('clear busts every declared tag through the same path', async () => {
    const { command, asked, closed } = fake({ peers: true });
    await command.run(ctxFor(appRoot(), ['cache', 'clear']));
    // The fixture app declares no entity, so the declared set is empty — and still one bust.
    expect(asked).toEqual([[]]);
    expect(closed()).toBe(1);
  });

  test('bust with no tag, and stats, refuse before anything boots', async () => {
    const { command, asked } = fake({ peers: true });
    const root = appRoot();
    await expect(command.run(ctxFor(root, ['cache', 'bust']))).rejects.toBeUltimateError(
      'X_CLI_BAD_FLAG',
    );
    await expect(command.run(ctxFor(root, ['cache', 'stats']))).rejects.toBeUltimateError(
      'X_NOT_IMPLEMENTED',
    );
    expect(asked).toEqual([]);
  });
});

describe('unit · x cache graph', () => {
  test('the bare form is the graph, read off the manifest, booting nothing', async () => {
    const { command, asked } = fake({ peers: true });
    const result = await command.run(ctxFor(appRoot(), ['cache']));
    expect(result.data).toEqual({ tags: [], neverEvicted: [] });
    expect(asked).toEqual([]);
  });

  test('--tag narrows the graph to one tag; with tags declared, an undeclared one is refused', async () => {
    const { command } = fake({ peers: true });
    const root = appRoot();
    const one = await command.run(ctxFor(root, ['cache', 'graph', '--tag', 'post:42']));
    expect(one.data).toEqual({ tags: [], neverEvicted: [] });
    const restore = isolateDeclaredTags();
    try {
      declareTags(['post']);
      await expect(
        command.run(ctxFor(root, ['cache', 'graph', '--tag', 'pots'])),
      ).rejects.toBeUltimateError('X_CACHE_TAG_UNKNOWN');
    } finally {
      restore();
    }
  });
});

describe('unit · x cache boots as a CLI command, not as the migrate step', () => {
  test("the shipped opener asks for 'ensure': a bust against production takes no migration lock", async () => {
    const modes: (SchemaMode | undefined)[] = [];
    let stopped = 0;
    const open = openAppCacheWith(async (_services, _env, _overrides, schema) => {
      modes.push(schema);
      return {
        transport: new InProcessTransport(),
        stop: async () => {
          stopped += 1;
        },
      } as unknown as RunningServices;
    });
    const handle = await open(appRoot(), ctxFor(appRoot(), ['cache', 'clear']));
    await handle.close();
    expect(modes).toEqual(['ensure']);
    expect(stopped).toBe(1);
  });
});
