// `x dev` over an embedded data directory that will not open sets it aside with a dated suffix and
// boots a fresh one, saying where the old one went. Before: `X_DB_UNAVAILABLE` "PGlite failed to
// initialize properly", whose fix was "run `x dev`" — the command that had just failed.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a real directory to rename; Bun has no rename/mkdtemp API of its own.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun ships no os/path API.
import { tmpdir } from 'node:os';
// why: Bun ships no path API.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { asideName, startOverUnopenable } from './dev-boot-data-dir';
import type { ServiceBinding } from './runtime-bindings';
import { embeddedLocation } from './runtime-bindings';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'x-dev-data-'));
  roots.push(root);
  const dir = join(root, 'pgdata');
  mkdirSync(dir);
  writeFileSync(join(dir, 'PG_VERSION'), '15\n');
  return dir;
}

const embedded = (dir: string): ServiceBinding => ({
  name: 'db',
  mode: 'embedded',
  url: embeddedLocation('pglite', dir),
  detail: 'PGlite',
});

const unavailable = (): UltimateError =>
  new UltimateError({ code: 'X_DB_UNAVAILABLE', cause: 'PGlite failed', fix: 'x dev' });

const NOW = new Date('2026-11-12T01:53:54.899Z');

describe('unit · an embedded data directory that will not open', () => {
  test('the suffix is the UTC instant, filename-safe', () => {
    expect(asideName('/a/.x/pgdata', NOW)).toBe('/a/.x/pgdata.unopenable-20261112T015354Z');
  });

  test('is set aside, the boot runs again over a fresh one, and the notice names both paths', async () => {
    const dir = dataDir();
    let starts = 0;
    const outcome = await startOverUnopenable(embedded(dir), {
      start: async () => {
        starts += 1;
        if (starts === 1) throw unavailable();
        return 'running';
      },
      opens: async () => false,
      now: () => NOW,
    });
    expect(outcome.value).toBe('running');
    expect(starts).toBe(2);
    const aside = asideName(dir, NOW);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(aside, 'PG_VERSION'))).toBe(true);
    expect(outcome.notice).toMatchObject({ code: 'X_DEV_DATA_UNOPENABLE', fix: 'x db migrate' });
    expect(outcome.notice?.cause).toContain(dir);
    expect(outcome.notice?.cause).toContain(aside);
  });

  test('a directory that opens is never moved: the boot failure was something else', async () => {
    const dir = dataDir();
    const failure = unavailable();
    const caught = await startOverUnopenable(embedded(dir), {
      start: async () => {
        throw failure;
      },
      opens: async () => true,
      now: () => NOW,
    }).catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(existsSync(dir)).toBe(true);
  });

  test('an external database is never probed or moved', async () => {
    const failure = unavailable();
    let probed = false;
    // A url that IS a directory on disk, so only the mode keeps it from being probed and moved.
    const dir = dataDir();
    const caught = await startOverUnopenable(
      { name: 'db', mode: 'external', url: dir, detail: '' },
      {
        start: async () => {
          throw failure;
        },
        opens: async () => {
          probed = true;
          return false;
        },
        now: () => NOW,
      },
    ).catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(probed).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  test('a boot that starts the first time reports nothing', async () => {
    const outcome = await startOverUnopenable(embedded(dataDir()), {
      start: async () => 'running',
      opens: async () => false,
      now: () => NOW,
    });
    expect(outcome).toEqual({ value: 'running' });
  });

  test('a first boot with no directory yet rethrows rather than inventing one', async () => {
    const failure = unavailable();
    const caught = await startOverUnopenable(embedded('/nonexistent/x-dev/pgdata'), {
      start: async () => {
        throw failure;
      },
      opens: async () => false,
      now: () => NOW,
    }).catch((error: unknown) => error);
    expect(caught).toBe(failure);
  });
});
