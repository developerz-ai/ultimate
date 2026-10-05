// The drain and health sections a container's boot hands its web server, read off the app's own
// config through the one loader.

import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and the fixtures are written synchronously.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { DRAIN_DEADLINE_DEFAULT_MS, defaultReadinessGraceMs } from '@ultimat3/core';
import { loadDrainConfig, loadHealthConfig } from './serve-drain';

const appWith = (config: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'serve-drain-'));
  writeFileSync(join(root, 'app.config.ts'), `export const config = ${config};\n`);
  return root;
};

const none = (): string => mkdtempSync(join(tmpdir(), 'serve-drain-none-'));

test('the declared readiness grace and drain budget are read off app.config.ts', async () => {
  const root = appWith('{ name: "demo", drain: { readinessGraceMs: 7000, deadlineMs: 120000 } }');
  expect(await loadDrainConfig(root)).toEqual({ readinessGraceMs: 7000, deadlineMs: 120_000 });
});

test('no drain section is core default; no config at all leaves the default to core', async () => {
  expect(await loadDrainConfig(appWith('{ name: "demo" }'))).toEqual({
    readinessGraceMs: defaultReadinessGraceMs(),
    deadlineMs: DRAIN_DEADLINE_DEFAULT_MS,
  });
  expect(await loadDrainConfig(none())).toBeUndefined();
});

test('the declared readiness mode is read off app.config.ts, and core default without one', async () => {
  const root = appWith('{ name: "demo", health: { readiness: "process" } }');
  expect(await loadHealthConfig(root)).toEqual({ readiness: 'process' });
  expect(await loadHealthConfig(appWith('{ name: "demo" }'))).toEqual({
    readiness: 'dependencies',
  });
  expect(await loadHealthConfig(none())).toBeUndefined();
});
