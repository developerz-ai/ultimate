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
  KEY_ORDER,
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
  permissions: ['post:publish'],
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

  // `KEY_ORDER` is hand-maintained and `contentHash` hashes the WHOLE body, so a 14th top-level
  // field would be built into the hash and then dropped from the file — after which `assertNoDrift`
  // convicts the file as HAND_EDITED, a correct refusal with the wrong diagnosis. The same
  // treatment `ARRAY_SECTIONS` already has, and for the same reason: `satisfies` catches a key that
  // does not exist, a walk catches one that is missing.
  test('KEY_ORDER covers every key a built manifest has — no field can be dropped in silence', () => {
    // Both sides as plain strings: `KEY_ORDER` is a union of key literals and `Object.keys` is
    // `string[]`, and `toEqual` infers its expected type from the actual one — so the comparison
    // this test exists to make does not typecheck until the two are read at the same width.
    const ordered: readonly string[] = KEY_ORDER;
    expect([...ordered].sort()).toEqual(Object.keys(fresh).sort());
  });

  test('every key of the built manifest survives the round trip to the file', () => {
    const written = JSON.parse(manifestJson(fresh)) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(Object.keys(fresh).sort());
    // …and the file's own bytes still verify against the hash taken over the whole body.
    expect(verifyBuildId(written as unknown as Manifest)).toBe(true);
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

  // `isManifest` checked five of the thirteen keys and CAST the rest, so a file with `routes`,
  // `actions` and `entities` was trusted whole — and `diffManifest` reads `before.queries`,
  // `before.jobs`, `before.permissions` and `before.locales` with no guard at all. The section it
  // did not check is a bare `TypeError` two calls later, out of the gate that exists to explain.
  test.each([
    ['jobs', 'a missing section'],
    ['queries', 'a missing section'],
    ['tasks', 'a missing section'],
    ['policies', 'a missing section'],
    ['permissions', 'a missing section'],
    ['locales', 'a missing section'],
    ['errorCodes', 'a missing section'],
    ['app', 'a missing app identity'],
  ])('%s is checked, not cast: %s reads as undefined', async (key) => {
    await withTempDir(async (path) => {
      const partial: Record<string, unknown> = { ...(fresh as unknown as Record<string, unknown>) };
      delete partial[key];
      await Bun.write(path, JSON.stringify(partial));
      expect(await readManifest(path)).toBeUndefined();
    });
  });

  test('a section of the wrong type reads as undefined', async () => {
    await withTempDir(async (path) => {
      await Bun.write(path, JSON.stringify({ ...fresh, jobs: {}, locales: 'en' }));
      expect(await readManifest(path)).toBeUndefined();
    });
  });

  test('an unreadable shape is drift with a code, never a TypeError from the diff', async () => {
    await withTempDir(async (path) => {
      const partial: Record<string, unknown> = { ...(fresh as unknown as Record<string, unknown>) };
      delete partial['jobs'];
      await Bun.write(path, JSON.stringify(partial));
      const thrown = await rejectedBy(() => assertNoDrift({ manifest: fresh, path }));
      expect(thrown.code).toBe('X_MANIFEST_DRIFT');
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

  // `bytes` is a byte count, and a manifest carries app strings — a locale name, an entity
  // description, a title in the app's own language. `String.length` counts UTF-16 code units, so
  // it under-reports every one of them, and `agents-md.ts` measures the same thing with
  // `Buffer.byteLength` one file away.
  test('bytes counts the bytes on disk, not the code units in the string', async () => {
    const accented = buildManifest({
      ...sources,
      app: { name: 'caf\u00e9-\u65e5\u672c-\ud83d\ude80', version: '1.4.2' },
    });
    await withTempDir(async (path) => {
      const result = await emitManifest({ manifest: accented, path });
      expect(result.bytes).toBe(Bun.file(path).size);
      expect(result.bytes).toBeGreaterThan(manifestJson(accented).length);
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

/**
 * `--json` must survive a pipe, and `emitManifest({ stdout: true })` IS the `--json` wire for the
 * manifest. `Bun.stdout.write()` returns a promise this function did not await, so the bytes past
 * the kernel buffer were still queued when the caller exited — the same discard
 * `scripts/stdout-truncation.test.ts` exists for, in the one function whose payload is the largest
 * thing the CLI ever prints.
 *
 * A real process, because the bug is not in-process: it is a property of fd 1 being a pipe and of
 * the runtime's write queue, and no mock reproduces either. Nothing reads until the child is gone,
 * so what it queued rather than wrote is still queued when it exits — asserting the rule instead
 * of racing a reader.
 */
describe('emitManifest to stdout', () => {
  /** Past any pipe buffer a Linux runner holds (~475KB measured), so the queue is non-empty. */
  const ROUTES = 60_000;

  test('every byte is written before the call resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-manifest-stdout-'));
    try {
      const script = join(dir, 'emit-json.ts');
      await Bun.write(
        script,
        [
          `import { buildManifest } from ${JSON.stringify(join(import.meta.dir, 'build.ts'))};`,
          `import { emitManifest } from ${JSON.stringify(join(import.meta.dir, 'emit.ts'))};`,
          `const routes = Array.from({ length: ${ROUTES} }, (_, i) => ({`,
          "  url: '/p/' + i,",
          "  render: 'static',",
          '}));',
          'const manifest = buildManifest({',
          "  app: { name: 'acme', version: '1.0.0' },",
          '  routes,',
          '  entities: [],',
          '  actions: [],',
          "  locales: ['en'],",
          '});',
          'await emitManifest({ manifest, stdout: true });',
          'process.exit(0);',
        ].join('\n'),
      );

      const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();

      expect(code).toBe(0);
      // Truncated output is not JSON, so a parse IS the assertion — plus the count, because a
      // payload that happened to break on a valid boundary would still be a lost manifest.
      const parsed = JSON.parse(out) as Manifest;
      expect(parsed.routes).toHaveLength(ROUTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The consequence of hashing over an INJECTIVE form rather than over what JSON can write down,
 * stated here so nobody has to rediscover it from a drift line.
 *
 * `buildId` now distinguishes values the document cannot: `-0`, `NaN`, `±Infinity` and a `Date`.
 * A fact carrying one of them therefore round-trips to a DIFFERENT body than the one that was
 * hashed, and the committed file no longer verifies against itself. That is the honest answer —
 * the file really does not describe the program — where the old `JSON.stringify(sortKeys(v))`
 * agreed with itself in silence while the file said `0` and the code said `-0`. It is also
 * unrepairable by regeneration, which is why it is pinned rather than left to be found: a manifest
 * FACT must be a value JSON can write, and every producer in the framework emits one.
 */
describe('unit · a fact JSON cannot write down no longer verifies, and that is deliberate', () => {
  const negativeZero: ManifestSources = {
    app: { name: 'acme', version: '1.0.0' },
    actions: [
      {
        name: 'setBalance',
        input: { type: 'object', properties: { amount: { default: -0 } } },
        output: {},
        policy: null,
        permissions: [],
        cacheInvalidates: [],
        mcp: { expose: true },
      },
    ],
  };

  test('a -0 default survives the build and does not survive the file', () => {
    const fresh = buildManifest(negativeZero);
    expect(verifyBuildId(fresh)).toBe(true);
    const onDisk = JSON.parse(manifestJson(fresh)) as Manifest;
    // `JSON.stringify(-0)` is `"0"`, so the parsed body is a different body.
    expect(verifyBuildId(onDisk)).toBe(false);
  });

  test('an ordinary fact round-trips unchanged, which is every fact the framework emits', () => {
    const fresh = buildManifest({
      ...negativeZero,
      actions: [{ ...((negativeZero.actions ?? [])[0] as ActionFact), input: { amount: 0 } }],
    });
    expect(verifyBuildId(JSON.parse(manifestJson(fresh)) as Manifest)).toBe(true);
  });
});
