import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameworkManifest } from './lib/framework-manifest';
import {
  canonical,
  contentHash,
  frameworkManifestJson,
  KEY_ORDER,
  manifestDrift,
  readFrameworkManifest,
} from './lib/framework-manifest';
import { repoRoot } from './lib/run';
import { buildManifest, DEFAULT_OUT, frameworkManifestDrift } from './manifest';

let dir = '';
let fresh: FrameworkManifest;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-framework-manifest-'));
  fresh = await buildManifest(repoRoot());
});

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
  test('two builds of one tree are byte-identical: no clock, no counter, no glob order', async () => {
    const again = await buildManifest(repoRoot());
    expect(frameworkManifestJson(again)).toBe(frameworkManifestJson(fresh));
    expect(again.buildId).toBe(fresh.buildId);
  });

  test('the generator actually finds the real packages and codes — not an empty list', () => {
    expect(fresh.packages.length).toBeGreaterThan(20);
    expect(fresh.packages.map((pkg) => pkg.name)).toContain('@ultimat3/core');
    expect(fresh.errorCodes.map((entry) => entry.code)).toContain('X_MANIFEST_DRIFT');
    expect(Object.keys(fresh.tiers)).toContain('0');
  });

  test('buildId is verifiable from the body alone', () => {
    expect(contentHash(bodyOf(fresh))).toBe(fresh.buildId);
    expect(fresh.buildId).toMatch(/^[0-9a-f]{12}$/);
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
      errorCodes: [...fresh.errorCodes, { code: 'X_INVENTED_FOR_A_TEST', package: 'core' }],
    };
    expect(contentHash(withCode)).not.toBe(fresh.buildId);
  });

  test('the hash reads the canonical form, so key order alone is never a change', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonical({ b: 1, a: 2 })).not.toBe(JSON.stringify({ b: 1, a: 2 }));
  });
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

  test('a hand-edited buildId over an unchanged body is still drift', () => {
    expect(manifestDrift({ ...fresh, buildId: '000000000000' }, fresh)).toEqual([
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
  test('freshly written: no drift; hand-edited: the section; deleted: missing', async () => {
    const path = join(dir, 'gate.json');
    await Bun.write(path, frameworkManifestJson(fresh));
    expect(await frameworkManifestDrift(repoRoot(), path)).toEqual([]);

    await Bun.write(path, frameworkManifestJson(withEditedVersion(fresh)));
    expect(await frameworkManifestDrift(repoRoot(), path)).toEqual(['packages differs']);

    await rm(path);
    expect(await frameworkManifestDrift(repoRoot(), path)).toEqual([
      'file is missing or unreadable',
    ]);
  });
});
