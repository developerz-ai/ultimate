import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { reportDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import { ADVISORY_FLOOR_UNMET, advisoryFloorFindings } from './doctor-advisory-floors';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A bun.lock in its real text shape: JSONC, trailing commas, nested `parent/name` keys. */
const lock = (packages: Readonly<Record<string, string>>): string =>
  [
    '{',
    '  "lockfileVersion": 1,',
    '  "packages": {',
    ...Object.entries(packages).map(
      ([key, resolved]) => `    "${key}": ["${resolved}", "", {}, "sha512-x"],`,
    ),
    '  },',
    '}',
    '',
  ].join('\n');

async function app(lockText: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-advisory-floors-'));
  roots.push(root);
  if (lockText !== undefined) await Bun.write(join(root, 'bun.lock'), lockText);
  return root;
}

describe('unit · x doctor advisory floors', () => {
  test('a patched tree is quiet', async () => {
    const root = await app(
      lock({
        'solid-js': 'solid-js@1.9.18',
        'source-map-js': 'source-map-js@1.2.2',
        immutable: 'immutable@5.1.9',
      }),
    );
    expect(await advisoryFloorFindings(root)).toEqual([]);
  });

  test('each resolved version under its floor is one warning naming the advisory and the fix', async () => {
    const root = await app(
      lock({
        'solid-js': 'solid-js@1.9.17',
        'source-map-js': 'source-map-js@1.2.2',
        'sass/source-map-js': 'source-map-js@1.2.1',
        immutable: 'immutable@5.1.7',
      }),
    );
    const findings = await advisoryFloorFindings(root);
    expect(findings.map((f) => f.code)).toEqual([
      ADVISORY_FLOOR_UNMET,
      ADVISORY_FLOOR_UNMET,
      ADVISORY_FLOOR_UNMET,
    ]);
    expect(findings.map((f) => f.cause)).toEqual([
      expect.stringContaining('solid-js 1.9.17'),
      expect.stringContaining('source-map-js 1.2.1'),
      expect.stringContaining('immutable 5.1.7'),
    ]);
    expect(findings[1]?.cause).toContain('GHSA-68fv-2mgg-jv7q');
    expect(findings[1]?.fix).toBe('bun update source-map-js immutable');
    expect(findings[0]?.fix).toBe('bun add --exact solid-js@1.9.18');
    expect(findings[0]?.at).toBe('bun.lock');
  });

  test('a git or tarball head is no version to order: skipped, never a crash of x doctor', async () => {
    const root = await app(
      lock({
        'solid-js': 'solid-js@github:solidjs/solid#4b0c3d1',
        'source-map-js': 'source-map-js@https://example.test/source-map-js.tgz',
        'sass/source-map-js': 'source-map-js@1.2.1',
      }),
    );
    const findings = await advisoryFloorFindings(root);
    expect(findings.map((f) => f.cause)).toEqual([expect.stringContaining('source-map-js 1.2.1')]);
  });

  test('no lockfile, or one that does not parse, is no finding: install has not run', async () => {
    expect(await advisoryFloorFindings(await app(undefined))).toEqual([]);
    expect(await advisoryFloorFindings(await app('{ not json'))).toEqual([]);
  });

  test('x doctor reports it beside the verdict, as a warning, never a finding', async () => {
    const root = await app(lock({ 'source-map-js': 'source-map-js@1.2.1' }));
    await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
    const result = await reportDoctor(probe({ root }));
    expect((result.findings ?? []).map((f) => f.code)).not.toContain(ADVISORY_FLOOR_UNMET);
    const data = result.data as { readonly warnings?: readonly { readonly code: string }[] };
    expect(data.warnings?.map((warning) => warning.code)).toContain(ADVISORY_FLOOR_UNMET);
  });
});
