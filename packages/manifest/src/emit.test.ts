// The serialisation and the gate around `x.manifest.json`: fixed key order, what a file that
// will not parse is allowed to mean, and the two separate ways a committed manifest goes stale —
// the code moved on, or someone typed into the generated file and left its buildId alone.

import { describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` give each test a throwaway tree, because
// nothing here may write inside the repo or into `examples/`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import {
  assertNoDrift,
  emitManifest,
  MANIFEST_FILENAME,
  manifestJson,
  readManifest,
  verifyBuildId,
} from './emit';
import type { ActionFact, Manifest } from './schema';

const publishPost: ActionFact = {
  name: 'publishPost',
  input: { postId: 'uuid' },
  output: { id: 'uuid' },
  policy: 'post:publish',
  cacheInvalidates: ['post'],
  mcp: { expose: true },
};

const sources: ManifestSources = {
  app: { name: 'acme', version: '1.4.2' },
  routes: [{ url: '/', render: 'static' }],
  entities: [{ name: 'post', table: 'posts', columns: [], invariants: [] }],
  actions: [publishPost],
  locales: ['en'],
};

const fresh = buildManifest(sources);
/** One fact moved, same permission set: drift with exactly one section to name. */
const moved = buildManifest({ ...sources, actions: [{ ...publishPost, mutator: true }] });

interface Thrown {
  readonly code?: string;
  readonly cause?: string;
  readonly fix?: string;
}

async function withTempDir<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-manifest-emit-'));
  try {
    return await run(join(dir, MANIFEST_FILENAME));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rejectedBy(call: () => Promise<unknown>): Promise<Thrown> {
  try {
    await call();
  } catch (error) {
    return error as Thrown;
  }
  return expect.unreachable('expected a rejection');
}

describe('manifestJson', () => {
  test('writes the top-level keys in KEY_ORDER, not the order the builder happened to use', () => {
    // `buildManifest` appends `buildId` last; the file puts it second, every time.
    const keys = Object.keys(JSON.parse(manifestJson(fresh)) as Record<string, unknown>);
    expect(keys).toEqual([
      'manifestVersion',
      'buildId',
      'app',
      'routes',
      'entities',
      'actions',
      'queries',
      'jobs',
      'tasks',
      'policies',
      'permissions',
      'locales',
      'errorCodes',
    ]);
  });

  test('is two-space indented and ends in a newline — it is diffed by git', () => {
    const text = manifestJson(fresh);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "buildId": ');
    expect(text).not.toContain('\n\t');
  });
});

describe('readManifest', () => {
  test('a file that is not there reads as undefined, never as an empty manifest', async () => {
    await withTempDir(async (path) => {
      expect(await readManifest(path)).toBeUndefined();
    });
  });

  test('a file that will not parse reads as undefined', async () => {
    await withTempDir(async (path) => {
      await Bun.write(path, '{ "manifestVersion": ');
      expect(await readManifest(path)).toBeUndefined();
    });
  });

  test('valid JSON of the wrong shape reads as undefined', async () => {
    await withTempDir(async (path) => {
      // Parses, and is still not a manifest: no `actions`, `routes` or `entities` to trust.
      await Bun.write(path, JSON.stringify({ manifestVersion: 1, buildId: 'abc' }));
      expect(await readManifest(path)).toBeUndefined();
    });
  });

  test('what emitManifest wrote is what readManifest reads back', async () => {
    await withTempDir(async (path) => {
      await emitManifest({ manifest: fresh, path });
      expect(await readManifest(path)).toEqual(fresh);
    });
  });
});

describe('emitManifest', () => {
  test('reports changed on the first write and not on an identical second one', async () => {
    await withTempDir(async (path) => {
      const first = await emitManifest({ manifest: fresh, path });
      expect(first).toEqual({
        path,
        bytes: manifestJson(fresh).length,
        buildId: fresh.buildId,
        changed: true,
      });

      // Same bytes means no write at all — an untouched mtime is what keeps watchers quiet.
      const second = await emitManifest({ manifest: fresh, path });
      expect(second.changed).toBe(false);
      expect(second.bytes).toBe(first.bytes);
      expect(await Bun.file(path).text()).toBe(manifestJson(fresh));
    });
  });

  test('a changed manifest over the same path reports changed again', async () => {
    await withTempDir(async (path) => {
      await emitManifest({ manifest: fresh, path });
      expect((await emitManifest({ manifest: moved, path })).changed).toBe(true);
      expect(await Bun.file(path).text()).toBe(manifestJson(moved));
    });
  });
});

describe('assertNoDrift', () => {
  test('a freshly emitted file is not drift', async () => {
    await withTempDir(async (path) => {
      await emitManifest({ manifest: fresh, path });
      expect(await assertNoDrift({ manifest: fresh, path })).toBeUndefined();
    });
  });

  test('no committed manifest at all is drift, with the command that writes one', async () => {
    await withTempDir(async (path) => {
      const thrown = await rejectedBy(() => assertNoDrift({ manifest: fresh, path }));
      expect(thrown.code).toBe('X_MANIFEST_DRIFT');
      expect(thrown.cause).toContain('missing or unreadable');
      expect(thrown.fix).toBe('x manifest');
    });
  });

  test('a file built from older code is drift, and names the section that moved', async () => {
    await withTempDir(async (path) => {
      await emitManifest({ manifest: fresh, path });
      const thrown = await rejectedBy(() => assertNoDrift({ manifest: moved, path }));
      expect(thrown.code).toBe('X_MANIFEST_DRIFT');
      expect(thrown.cause).toContain('actions differs');
    });
  });

  // The failure the whole drift gate exists to kill: an agent edits the generated file to say
  // what it wishes were true and leaves `buildId` alone, so the id still equals a fresh build's.
  test('a body edited by hand is drift even though its buildId matches the code', async () => {
    await withTempDir(async (path) => {
      const tampered: Manifest = { ...fresh, app: { name: 'acme', version: '99.0.0' } };
      expect(tampered.buildId).toBe(fresh.buildId);
      expect(verifyBuildId(fresh)).toBe(true);
      expect(verifyBuildId(tampered)).toBe(false);
      await Bun.write(path, manifestJson(tampered));

      const thrown = await rejectedBy(() => assertNoDrift({ manifest: fresh, path }));
      expect(thrown.code).toBe('X_MANIFEST_DRIFT');
      expect(thrown.cause).toContain('hand-edited');
      expect(thrown.fix).toBe('x manifest');
    });
  });
});
