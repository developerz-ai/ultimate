import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argsFor, BUILD_ENTRY, BUILD_TARGETS, readTarget, requireEntry } from './cmd-build';
import { planNewApp } from './cmd-new';
import type { ThrownShape } from './thrown-by';
import { thrownBy } from './thrown-by';

test('every build target has an entry, and `x new` writes every one of them', () => {
  const scaffolded = new Set(planNewApp({ name: 'entry-app', example: true }).map((f) => f.path));
  for (const target of BUILD_TARGETS) {
    // This is the bug the table exists to prevent: `binary` compiled `apps/web/server.ts` and
    // `static` ran `apps/web/prerender.ts` while `x new` wrote neither, so a scaffolded app had
    // no deployable artifact at all.
    expect(scaffolded.has(BUILD_ENTRY[target])).toBe(true);
  }
});

test('the spawned command names the same file the entry check required', () => {
  const root = '/app';
  for (const target of BUILD_TARGETS) {
    expect(argsFor(target, { root, tag: 't', out: '/out' }).join(' ')).toContain(
      join(root, BUILD_ENTRY[target]),
    );
  }
});

test('a missing entry is refused by name, before anything is spawned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-'));
  try {
    const thrown: ThrownShape = thrownBy(() => requireEntry(dir, 'binary'));
    expect(thrown.code).toBe('X_BUILD_ENTRY_MISSING');
    expect(thrown.cause).toContain('apps/web/server.ts');
    expect(thrown.fix).toContain('apps/web/server.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry that is present resolves to its absolute path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-'));
  try {
    await Bun.write(join(dir, 'docker/Dockerfile'), 'FROM oven/bun:1.3-alpine\n');
    expect(requireEntry(dir, 'docker')).toBe(join(dir, 'docker', 'Dockerfile'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown target names the known ones and a working invocation', () => {
  expect(readTarget(undefined)).toBe('docker');
  const thrown: ThrownShape = thrownBy(() => readTarget('lambda'));
  expect(thrown.code).toBe('X_CLI_UNKNOWN_COMMAND');
  expect(thrown.fix).toBe('x build --target docker');
});
