// A wrapper published by a stranger is a first-class citizen: its entity, its action and its job,
// installed under `node_modules/` and only re-exported by the app, reach `x entities`, the
// manifest and the MCP tool list, its policy refuses, and its job runs. Nothing in the framework
// may learn where a primitive came from — this file fails the day one does. One child process,
// because the registries are process-global and `import()` caches by path.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm` tears the fixture tree down after the run.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.write and Bun.spawn take one already joined.
import { join } from 'node:path';
import { processRoot } from './process-root-fixture';
import {
  THIRD_PARTY_ACTION,
  THIRD_PARTY_ENTITY,
  THIRD_PARTY_JOB,
  THIRD_PARTY_PACKAGE,
  thirdPartyFiles,
  thirdPartyProbe,
} from './third-party-wrapper-fixture';

// Under `packages/cli/` so the package's bare `@ultimat3/*` imports resolve to the same modules the
// CLI's own do — the way a consumer's single install would.
const ROOT = processRoot(join(import.meta.dir, '..', '.third-party-wrapper-fixture'));
const MAJOR = Number(
  (
    (await Bun.file(join(import.meta.dir, '..', 'package.json')).json()) as { version: string }
  ).version.split('.')[0],
);

interface Probe {
  readonly findings: readonly string[];
  readonly entities: readonly string[];
  readonly manifest: {
    readonly entities: readonly string[];
    readonly actions: readonly string[];
    readonly jobs: readonly string[];
  };
  readonly tools: readonly string[];
  readonly refused: {
    readonly result?: { readonly isError?: boolean; readonly content?: unknown };
  };
  readonly allowed: {
    readonly result?: { readonly isError?: boolean; readonly content?: unknown };
  };
  readonly runs: readonly (readonly [string, unknown])[];
}

let probe: Probe;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, body] of Object.entries(thirdPartyFiles(MAJOR))) {
    await Bun.write(join(ROOT, path), body);
  }
  const child = Bun.spawn(['bun', '-e', thirdPartyProbe(import.meta.dir, ROOT)], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 90_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split('\n').find((one) => one.startsWith('probe:'));
  if (code !== 0 || line === undefined) expect.unreachable(`child failed (${code}): ${stderr}`);
  probe = JSON.parse(line.slice('probe:'.length)) as Probe;
}, 120_000);

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('integration · a third-party wrapper package, installed and re-exported', () => {
  test('the package is shaped the way the wiki says: unscoped, peers at ^<major>, never deps', async () => {
    const manifest = (await Bun.file(
      join(ROOT, 'node_modules', THIRD_PARTY_PACKAGE, 'package.json'),
    ).json()) as Record<string, unknown>;
    expect(THIRD_PARTY_PACKAGE).toStartWith('ultimate-');
    expect(manifest['dependencies']).toBeUndefined();
    expect(Object.values(manifest['peerDependencies'] as Record<string, string>)).toEqual(
      Array(5).fill(`^${String(MAJOR)}.0.0`),
    );
  });

  test('the app loads with no finding', () => {
    expect(probe.findings).toEqual([]);
  });

  test('`x entities` lists its entity, built by its own factory', () => {
    expect(probe.entities).toContain(THIRD_PARTY_ENTITY);
  });

  test('the manifest holds its entity, its action and its job', () => {
    expect(probe.manifest.entities).toContain(THIRD_PARTY_ENTITY);
    expect(probe.manifest.actions).toContain(THIRD_PARTY_ACTION);
    expect(probe.manifest.jobs).toContain(THIRD_PARTY_JOB);
  });

  test('tools/list holds its action', () => {
    expect(probe.tools).toContain(THIRD_PARTY_ACTION);
  });

  test('its policy refuses a caller without the grant and admits one with it', () => {
    expect(probe.refused.result?.isError).toBe(true);
    expect(JSON.stringify(probe.refused.result?.content)).toContain('X_FORBIDDEN');
    expect(probe.allowed.result?.isError).not.toBe(true);
    expect(JSON.stringify(probe.allowed.result?.content)).toContain('hello');
  });

  test('its job runs', () => {
    expect(probe.runs).toEqual([['completed', { pruned: '2026-11-03' }]]);
  });
});
