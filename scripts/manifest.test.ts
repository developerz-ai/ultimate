import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { registeredErrorCodes } from '@ultimat3/cli';
import { canonicalJson as canonical } from '@ultimat3/core';
import type { FrameworkManifest } from './lib/framework-manifest';
import {
  contentHash,
  frameworkManifestJson,
  KEY_ORDER,
  manifestDrift,
  readFrameworkManifest,
} from './lib/framework-manifest';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { buildManifest, DEFAULT_OUT, frameworkManifestDrift, ownerOf } from './manifest';

let dir = '';
let fresh: FrameworkManifest;

// `buildManifest(repoRoot())` is a full manifest regeneration over 29 packages, run once here for
// the whole file — `REPO_SCAN_TIMEOUT_MS`.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-framework-manifest-'));
  fresh = await buildManifest(repoRoot());
}, REPO_SCAN_TIMEOUT_MS);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bodyOf = (manifest: FrameworkManifest) => {
  const { buildId, ...body } = manifest;
  return body;
};

/** A copy with one real fact changed — the smallest edit the gate has to notice. */
const withEditedVersion = (manifest: FrameworkManifest): FrameworkManifest => ({
  ...manifest,
  packages: manifest.packages.map((pkg, index) =>
    index === 0 ? { ...pkg, version: '99.99.99' } : pkg,
  ),
});

describe('unit · the framework manifest is generated, not written', () => {
  // A SECOND full `buildManifest(repoRoot())` on top of the one `beforeAll` already ran — the
  // comparison is the point, so the body pays the scan twice.
  test(
    'two builds of one tree are byte-identical: no clock, no counter, no glob order',
    async () => {
      const again = await buildManifest(repoRoot());
      expect(frameworkManifestJson(again)).toBe(frameworkManifestJson(fresh));
      expect(again.buildId).toBe(fresh.buildId);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('the generator actually finds the real packages and codes — not an empty list', () => {
    expect(fresh.packages.length).toBeGreaterThan(20);
    expect(fresh.packages.map((pkg) => pkg.name)).toContain('@ultimat3/core');
    expect(fresh.errorCodes.map((entry) => entry.code)).toContain('X_MANIFEST_DRIFT');
    expect(Object.keys(fresh.tiers)).toContain('0');
  });

  test('buildId moves when a code moves file, because `at` is a fact like any other', () => {
    const moved = {
      ...bodyOf(fresh),
      errorCodes: fresh.errorCodes.map((entry, index) =>
        index === 0 ? { ...entry, at: 'packages/core/src/somewhere-else.ts' } : entry,
      ),
    };
    expect(contentHash(moved)).not.toBe(fresh.buildId);
  });

  test('buildId is verifiable from the body alone', () => {
    expect(contentHash(bodyOf(fresh))).toBe(fresh.buildId);
    // A whole sha256, not a prefix: a truncated digest collides, and a collision reads as fresh.
    expect(fresh.buildId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('buildId moves when a package version moves', () => {
    expect(contentHash(bodyOf(withEditedVersion(fresh)))).not.toBe(fresh.buildId);
  });

  // The bug this hash replaced: it covered `name@version` plus the codes, so the tier table could
  // change under a buildId that never moved.
  test('buildId moves when the TIER TABLE moves', () => {
    const retiered = { ...bodyOf(fresh), tiers: { ...fresh.tiers, '0': ['core', 'schema', 'db'] } };
    expect(contentHash(retiered)).not.toBe(fresh.buildId);
  });

  test('buildId moves when an error code is added', () => {
    const withCode = {
      ...bodyOf(fresh),
      errorCodes: [
        ...fresh.errorCodes,
        { code: 'X_INVENTED_FOR_A_TEST', owner: 'core', at: 'packages/core/src/errors.ts' },
      ],
    };
    expect(contentHash(withCode)).not.toBe(fresh.buildId);
  });

  test('the hash reads the canonical form, so key order alone is never a change', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonical({ b: 1, a: 2 })).not.toBe(JSON.stringify({ b: 1, a: 2 }));
  });
});

describe('unit · every code, not the ones in one filename per package', () => {
  const entryFor = (code: string) => fresh.errorCodes.find((entry) => entry.code === code);

  // The bug: the scan globbed `packages/<pkg>/src/errors.ts` and nothing else, so core's
  // `error-codes.ts` — twenty codes, the framework's own registry — was absent from a file whose
  // whole claim is "every X_* code and its owner".
  test('a code in a registry the old glob could not name is in the manifest', () => {
    expect(entryFor('X_ROLE_INVALID')).toEqual({
      code: 'X_ROLE_INVALID',
      owner: 'core',
      at: 'packages/core/src/error-codes.ts',
    });
    expect(entryFor('X_UNREACHABLE')?.owner).toBe('core');
    expect(entryFor('X_SERVICE_MISSING')?.owner).toBe('core');
  });

  // Eleven packages throw `X_NOT_IMPLEMENTED` and each says in its own registry that the code is
  // core's. The manifest said `storage`, which is only the package that sorted first.
  test('a borrowed code is attributed to the package that owns it', () => {
    expect(entryFor('X_NOT_IMPLEMENTED')).toEqual({
      code: 'X_NOT_IMPLEMENTED',
      owner: 'core',
      at: 'packages/core/src/error-codes.ts',
    });
    expect(entryFor('X_DB_DRIFT')?.owner).toBe('db');
    expect(entryFor('X_UNAUTHENTICATED')?.owner).toBe('auth');
  });

  // `scripts/` ships to nobody, so no package may own these — but they are codes an agent can be
  // handed by this repo's own gate, and a manifest that omitted them would be answering a
  // narrower question than the one it is asked.
  test('a code only this repo’s gate throws is in the manifest, owned by scripts', () => {
    expect(entryFor('X_BOUNDARY_VIOLATION')).toEqual({
      code: 'X_BOUNDARY_VIOLATION',
      owner: 'scripts',
      at: 'scripts/boundaries.ts',
    });
    expect(fresh.errorCodes.filter((entry) => entry.owner === 'scripts').length).toBeGreaterThan(4);
  });

  test('ownerOf reads a package by name and anything else by its top directory', () => {
    expect(ownerOf('packages/core/src/roles.ts')).toBe('core');
    expect(ownerOf('packages/cli/src/templates/deep/thing.ts')).toBe('cli');
    expect(ownerOf('scripts/boundaries.ts')).toBe('scripts');
    expect(ownerOf('docker/entrypoint.ts')).toBe('docker');
  });

  /**
   * The independent check: the process-wide registry is built by importing every package and is
   * derived from nothing this generator reads. A registered code the manifest cannot name is
   * exactly the drift the old scan shipped — 17 of them, `X_ROLE_INVALID` and friends.
   *
   * `registeredErrorCodes()` dynamically imports every @ultimat3/* package — the same real,
   * unavoidable import-graph cost the rest of these scans pay, so `REPO_SCAN_TIMEOUT_MS`.
   */
  test(
    'every code x errors explain answers for is in the manifest',
    async () => {
      const listed = new Set(fresh.errorCodes.map((entry) => entry.code));
      const missing = [...(await registeredErrorCodes())]
        .filter((code) => !listed.has(code))
        .sort();
      expect(missing).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('a code only a test file invents is not a code', () => {
    const codes = fresh.errorCodes.map((entry) => entry.code);
    expect(codes).not.toContain('X_INVENTED_FOR_A_TEST');
    expect(codes).not.toContain('X_MADE_UP');
    expect(codes).not.toContain('X_GHOST');
  });

  // `at` is load-bearing or it is decoration: every one has to point at a file that really is
  // where that code is written. One `Bun.file().exists()` + `.text()` round trip per shipped
  // code — a couple hundred real file reads scattered across every package in the repo, not one
  // in-memory assertion — so `REPO_SCAN_TIMEOUT_MS`.
  test(
    'every `at` names a real file that really declares its code',
    async () => {
      const unreadable: string[] = [];
      for (const entry of fresh.errorCodes) {
        const source = Bun.file(join(repoRoot(), entry.at));
        if (!(await source.exists()) || !(await source.text()).includes(entry.code)) {
          unreadable.push(`${entry.code} -> ${entry.at}`);
        }
      }
      expect(unreadable).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

describe('unit · the bytes on disk', () => {
  test('fixed key order, two-space indent, trailing newline', () => {
    const text = frameworkManifestJson(fresh);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "version": 1,');
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual([...KEY_ORDER]);
  });

  test('what is written reads back as the same manifest', async () => {
    const path = join(dir, 'round-trip.json');
    await Bun.write(path, frameworkManifestJson(fresh));
    expect(await readFrameworkManifest(path)).toEqual(fresh);
  });

  test('an absent file and a corrupt one both read as undefined, never as a manifest', async () => {
    const corrupt = join(dir, 'corrupt.json');
    await Bun.write(corrupt, '{ not json');
    expect(await readFrameworkManifest(join(dir, 'absent.json'))).toBeUndefined();
    expect(await readFrameworkManifest(corrupt)).toBeUndefined();
    const wrongShape = join(dir, 'wrong-shape.json');
    await Bun.write(wrongShape, '{"version":1,"buildId":"abc"}');
    expect(await readFrameworkManifest(wrongShape)).toBeUndefined();
  });

  // The committed file is the whole point of the path change: a manifest under .x/ was ignored by
  // git, so there was never anything to diff against. Freshness is the gate's job, not this test's.
  test('the committed manifest exists, parses, and its buildId matches its own body', async () => {
    const committed = await readFrameworkManifest(join(repoRoot(), DEFAULT_OUT));
    expect(committed).toBeDefined();
    if (committed === undefined) return;
    expect(contentHash(bodyOf(committed))).toBe(committed.buildId);
    expect(DEFAULT_OUT).toBe('framework.manifest.json');
  });
});

describe('unit · drift names the section that moved', () => {
  test('a file built from this tree is not drift', () => {
    expect(manifestDrift(fresh, fresh)).toEqual([]);
  });

  test('an edited package version reports packages, and nothing else', () => {
    const edited = withEditedVersion(fresh);
    expect(manifestDrift(edited, fresh)).toEqual(['packages differs']);
  });

  test('an edited tier table reports tiers', () => {
    const edited: FrameworkManifest = { ...fresh, tiers: { ...fresh.tiers, '9': ['nothing'] } };
    expect(manifestDrift(edited, fresh)).toEqual(['tiers differs']);
  });

  test('two sections moving are both named', () => {
    const edited: FrameworkManifest = {
      ...withEditedVersion(fresh),
      errorCodes: fresh.errorCodes.slice(1),
    };
    expect(manifestDrift(edited, fresh)).toEqual(['packages differs', 'errorCodes differs']);
  });

  // The edit is a structurally valid buildId — full digest length, wrong value — so what this
  // catches is the mismatch itself and not a shape check that would reject any short string.
  test('a hand-edited buildId over an unchanged body is still drift', () => {
    expect(manifestDrift({ ...fresh, buildId: '0'.repeat(64) }, fresh)).toEqual([
      'buildId differs',
    ]);
  });

  test('a reordered file is not drift: comparison is canonical', () => {
    const reordered = JSON.parse(canonical(fresh)) as FrameworkManifest;
    expect(manifestDrift(reordered, fresh)).toEqual([]);
  });

  test('a missing file is one explanatory entry, not an empty pass', () => {
    expect(manifestDrift(undefined, fresh)).toEqual(['file is missing or unreadable']);
  });
});

describe('unit · the gate reads the file, not just the generator', () => {
  // THREE manifest regenerations over 29 packages, one per assertion. See the note in
  // `verify.test.ts`: the 5s default cannot cover this once shards share the machine.
  test(
    'freshly written: no drift; hand-edited: the section; deleted: missing',
    async () => {
      const path = join(dir, 'gate.json');
      await Bun.write(path, frameworkManifestJson(fresh));
      expect(await frameworkManifestDrift(repoRoot(), path)).toEqual([]);

      await Bun.write(path, frameworkManifestJson(withEditedVersion(fresh)));
      expect(await frameworkManifestDrift(repoRoot(), path)).toEqual(['packages differs']);

      await rm(path);
      expect(await frameworkManifestDrift(repoRoot(), path)).toEqual([
        'file is missing or unreadable',
      ]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
