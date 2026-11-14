// The registry fixture's bar for a failed pack: it dies before the one stdout JSON line, and its
// stderr names the package and the reason — what `packFailed`'s doc block states. The only other
// spawner, `upgrade.e2e.test.ts`, pins the happy path, where every pack succeeds.
//
//   bun test ./packages/cli/e2e/upgrade-registry-fixture.e2e.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no mkdir and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';

const FIXTURE = join(import.meta.dir, 'upgrade-registry-fixture.ts');
const FROM = '30.0.0';
const TO = '31.0.0';

const roots: string[] = [];

/** The stderr lines naming the failed package — one is the contract, two a double report. */
const named = (stderr: string, name: string): readonly string[] =>
  stderr.split('\n').filter((line) => line.includes(`packing ${name} failed`));

/** Run the fixture to completion: every test here drives a failure, which always exits. */
const runFixture = (root: string) =>
  Bun.spawnSync([process.execPath, FIXTURE, root, FROM, TO, join(root, 'work')], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });

/** A fabricated checkout: `packages/cli` with the real prepack, a `packWiki` that refuses. */
const refusingRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ultimate-upgrade-pack-e2e-'));
  // Claimed by afterAll even if a later step here throws: this test owns every dir it makes.
  roots.push(root);
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'cli', 'package.json'),
    JSON.stringify({
      name: '@ultimat3/cli',
      version: FROM,
      scripts: { prepack: 'bun run ../../scripts/pack-cli-wiki.ts' },
    }),
  );
  // The hook the fixture runs imports this module and exits 1 on its finding — the real script's
  // refusal shape (`packWiki` returning a finding) — without touching a filesystem.
  writeFileSync(
    join(root, 'scripts', 'pack-cli-wiki.ts'),
    `export function packWiki(_root: string): { finding?: { cause: string } } {
  return { finding: { cause: 'fabricated: this root refuses to ship its wiki' } };
}
`,
  );
  return root;
};

/** A fabricated checkout whose one workspace directory has no package.json at all. */
const missingManifestRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ultimate-upgrade-nomani-e2e-'));
  roots.push(root);
  mkdirSync(join(root, 'packages', 'broken'), { recursive: true });
  return root;
};

describe('the registry fixture names a failed pack before its stdout line', () => {
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test('a refused prepack dies here, named by its package', () => {
    const ran = runFixture(refusingRoot());
    expect(ran.exitCode).toBe(1);
    // No stdout {url} line: the e2e's reader would see only end-of-stream and an unnamed exit.
    expect(ran.stdout.toString()).not.toContain('"url"');
    const lines = named(ran.stderr.toString(), '@ultimat3/cli');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pack-cli-wiki refused');
    // The hook's own finding rode inherited stderr above the naming line, as the bar requires.
    expect(ran.stderr.toString()).toContain('fabricated: this root refuses to ship its wiki');
  }, 60_000);

  test('a missing package.json dies here, named by its directory', () => {
    const ran = runFixture(missingManifestRoot());
    expect(ran.exitCode).toBe(1);
    expect(ran.stdout.toString()).not.toContain('"url"');
    const lines = named(ran.stderr.toString(), 'broken');
    expect(lines).toHaveLength(1);
    // The manifest never yielded a name, so the fallback is the workspace directory itself.
    expect(lines[0]).toContain('ENOENT');
  }, 60_000);
});
