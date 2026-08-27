// The rewrite, driven over a lockfile fragment rather than the committed file: the negative case
// has to be a fixture, or the only way to see this rule fail is to break the repo's own install.
// `lockfile-pins.stale-fixture.lock` is the second half — the `workspaces` object of the real
// `bun.lock` as committed at 7.0.0, verbatim, frozen at the 72 stale ranges and 30 stale workspace
// versions the shipped check reported as zero.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import type { DeclaredFacts } from './lockfile-pins';
import { correctLockfile, declaredFacts } from './lockfile-pins';

const ROOT = repoRoot();

/** Two workspace blocks in `bun.lock`'s own shape, one stale and one already correct. */
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "packages/action": {
      "name": "@ultimat3/action",
      "version": "3.0.0",
      "dependencies": {
        "@ultimat3/core": "2.0.0",
        "@ultimat3/schema": "3.0.0",
      },
    },
    "packages/core": {
      "name": "@ultimat3/core",
      "version": "3.0.0",
    },
  },
}
`;

const DECLARED = {
  deps: { 'packages/action': { '@ultimat3/core': '3.0.0', '@ultimat3/schema': '3.0.0' } },
  versions: { 'packages/action': '3.0.0', 'packages/core': '3.0.0' },
};

describe('correcting the recorded ranges', () => {
  test('a range the manifest disagrees with is rewritten, and reported', () => {
    const { text, edits } = correctLockfile(LOCK, DECLARED);
    expect(edits).toEqual([
      {
        kind: 'range',
        dir: 'packages/action',
        dep: '@ultimat3/core',
        locked: '2.0.0',
        declared: '3.0.0',
      },
    ]);
    expect(text).toContain('"@ultimat3/core": "3.0.0"');
    expect(text).not.toContain('"2.0.0"');
  });

  test('a range that already agrees is not an edit — the pass is idempotent', () => {
    const once = correctLockfile(LOCK, DECLARED);
    const twice = correctLockfile(once.text, DECLARED);
    expect(twice.edits).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  test('a workspace with no manifest entry is left exactly as found', () => {
    // The lockfile is the authority on nothing; a block this pass cannot check, it does not touch.
    const { text, edits } = correctLockfile(LOCK, { deps: {}, versions: {} });
    expect(edits).toEqual([]);
    expect(text).toBe(LOCK);
  });

  test('only the @ultimat3 ranges move — an external pin is not this pass to change', () => {
    // The whole reason this is surgical: `rm bun.lock && bun install` also drags every external
    // dependency to its newest matching release, which on 2026-08-19 moved Biome two patches.
    const withExternal = LOCK.replace(
      '"@ultimat3/schema": "3.0.0",',
      '"@ultimat3/schema": "3.0.0",\n        "@biomejs/biome": "2.5.5",',
    );
    const { text } = correctLockfile(withExternal, DECLARED);
    expect(text).toContain('"@biomejs/biome": "2.5.5"');
  });

  test('a package.json range the lockfile has no line for adds nothing', () => {
    // The pass rewrites what is recorded; it never invents an edge, because a missing edge is a
    // question for `bun install`, not for a text rewrite.
    const { text, edits } = correctLockfile(LOCK, {
      deps: { 'packages/action': { '@ultimat3/core': '3.0.0', '@ultimat3/nothing': '3.0.0' } },
      versions: {},
    });
    // The one real correction still happens; the edge the lockfile never recorded is not invented.
    expect(edits.map((edit) => (edit.kind === 'range' ? edit.dep : edit.dir))).toEqual([
      '@ultimat3/core',
    ]);
    expect(text).not.toContain('@ultimat3/nothing');
  });
});

describe('the two shapes the shipped pattern could not see', () => {
  test('a DIGIT in the package name — `i18n`, which `[a-z-]+` reads as no dependency at all', () => {
    const lock = LOCK.replace('"@ultimat3/core": "2.0.0",', '"@ultimat3/i18n": "1.2.0",');
    const { edits } = correctLockfile(lock, {
      deps: { 'packages/action': { '@ultimat3/i18n': '3.0.0' } },
      versions: {},
    });
    expect(edits).toEqual([
      {
        kind: 'range',
        dir: 'packages/action',
        dep: '@ultimat3/i18n',
        locked: '1.2.0',
        declared: '3.0.0',
      },
    ]);
  });

  test('an APP workspace — the key is a path, and it shares this lockfile', () => {
    const lock = LOCK.replace('"packages/action"', '"examples/dummy/apps/web"');
    const { text, edits } = correctLockfile(lock, {
      deps: { 'examples/dummy/apps/web': { '@ultimat3/core': '3.0.0' } },
      versions: {},
    });
    expect(edits.map((edit) => edit.dir)).toEqual(['examples/dummy/apps/web']);
    // The key is re-emitted at its own indentation: a `--write` that shifted it breaks the install.
    expect(text).toContain('    "examples/dummy/apps/web": {');
  });

  test('the sibling `packages` section is never read as a workspace block', () => {
    // Every entry there maps a name to an ARRAY, so `:\s*{` cannot reach it — asserted, because a
    // pattern that did would rewrite an external dependency's resolution.
    const lock = `${LOCK.trimEnd().slice(0, -1)}  "packages": {
    "@ultimat3/core": ["@ultimat3/core@2.0.0", "", {}, ""],
  },
}
`;
    const { edits } = correctLockfile(lock, {
      deps: { '@ultimat3/core': { '@ultimat3/core': '3.0.0' } },
      versions: {},
    });
    expect(edits).toEqual([]);
  });
});

describe('a root that is not a repo', () => {
  test('reads no facts rather than throwing — this runs inside a HostCheck', async () => {
    // `workspaceManifests` used to throw ENOENT here, which `x verify` catches as an internal
    // failure: the operator gets a stack trace where a finding belonged.
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-lockfile-pins-'));
    try {
      expect(await declaredFacts(dir)).toEqual({ deps: {}, versions: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Both halves of the fixture, frozen together. `lockfile-pins.stale-fixture.lock` is the 7.0.0 tree
 * as it stood before the fix; comparing it against LIVE manifests reds the day a workspace or an
 * `@ultimat3/*` dependency is added — `toHaveLength(72)` fails, and the failure reads as a bug in
 * `correctLockfile` rather than as a fixture that aged. The live invariant is asserted once, at the
 * bottom of this block, where it belongs: `bun.lock` against the manifests it was generated from.
 */
const STALE_FACTS = (await Bun.file(
  `${ROOT}/scripts/lockfile-pins.stale-fixture.facts.json`,
).json()) as DeclaredFacts;

describe('the lockfile as committed', () => {
  test('the frozen pre-fix lock carries 72 stale ranges, which the shipped pattern reported as 0', async () => {
    const stale = await Bun.file(`${ROOT}/scripts/lockfile-pins.stale-fixture.lock`).text();
    const { edits } = correctLockfile(stale, STALE_FACTS);
    expect(edits.filter((edit) => edit.kind === 'range')).toHaveLength(72);
    // The three shapes named in the finding, each from a block the old anchor could not reach.
    expect(edits.some((edit) => edit.dir === 'packages/i18n')).toBe(true);
    expect(edits.some((edit) => edit.dir === 'dummy/social-media-clone')).toBe(true);
    expect(edits.some((edit) => edit.locked === '^1.2.0')).toBe(true);
  });

  test('and 30 stale workspace VERSIONS beside them — one per framework package', async () => {
    // The second fact per block, and the one `bun install --frozen-lockfile` accepted at every
    // framework workspace: 6.0.0 recorded against a manifest that says 7.0.0.
    const stale = await Bun.file(`${ROOT}/scripts/lockfile-pins.stale-fixture.lock`).text();
    const { edits } = correctLockfile(stale, STALE_FACTS);
    const versions = edits.filter((edit) => edit.kind === 'version');
    expect(versions).toHaveLength(30);
    expect(versions.every((edit) => edit.locked === '6.0.0')).toBe(true);
  });

  test('and correcting it rewrites facts only — never a line more', async () => {
    const stale = await Bun.file(`${ROOT}/scripts/lockfile-pins.stale-fixture.lock`).text();
    const { text } = correctLockfile(stale, STALE_FACTS);
    expect(text.split('\n')).toHaveLength(stale.split('\n').length);
    expect(correctLockfile(text, STALE_FACTS).edits).toEqual([]);
  });

  test('bun.lock itself agrees with every package.json it was generated from', async () => {
    const lock = await Bun.file(`${ROOT}/bun.lock`).text();
    const { edits } = correctLockfile(lock, await declaredFacts(ROOT));
    expect(edits).toEqual([]);
  });
});
