// The database probe's own seams, which `cmd-doctor-probe.test.ts` only ever stubs: the reading of
// `DATABASE_URL`, the `node_modules` walk, and a real `select 1` against a port nothing listens on.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch tree must be a fresh directory per run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalUrl, installedAbove, probeDatabase } from './doctor-database';

const scratch = mkdtempSync(join(tmpdir(), 'x-doctor-db-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('unit · x doctor · DATABASE_URL, read once for both halves', () => {
  test('unset and blank are one case; anything else is the external database', () => {
    expect(externalUrl(undefined)).toBeUndefined();
    expect(externalUrl('  \t')).toBeUndefined();
    expect(externalUrl('postgres://u@h/db')).toBe('postgres://u@h/db');
  });
});

describe('unit · x doctor · the installed-peer walk', () => {
  test('a package installed by a hoisting workspace above the app counts', () => {
    const pkg = join(scratch, 'hoisted', 'node_modules', '@scope', 'peer');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    const app = join(scratch, 'hoisted', 'apps', 'one');
    mkdirSync(app, { recursive: true });
    expect(installedAbove(app, '@scope/peer')).toBe(true);
  });

  test('a directory with no package.json is not an install', () => {
    const app = join(scratch, 'empty');
    mkdirSync(join(app, 'node_modules', '@scope', 'peer'), { recursive: true });
    expect(installedAbove(app, '@scope/peer')).toBe(false);
  });
});

describe('unit · x doctor · the external database probe', () => {
  test('no external database is no finding, and opens no pool', async () => {
    expect(await probeDatabase(undefined, {})).toBeNull();
    expect(await probeDatabase('   ', {})).toBeNull();
  });

  test('a client that cannot be built is its own refusal, carried whole', async () => {
    const found = await probeDatabase('postgres://u@127.0.0.1:1/db', {
      DATABASE_POOLER: 'bogus',
    });
    expect(found?.code).toBe('X_ENV_MISSING');
    expect(found?.fix).toContain('DATABASE_POOLER=session');
  });

  test('a refused session is X_DB_UNAVAILABLE with @ultimat3/db own fix', async () => {
    const found = await probeDatabase('postgres://u:p@127.0.0.1:1/db', {});
    expect(found?.code).toBe('X_DB_UNAVAILABLE');
    expect(found?.cause).toStartWith('DATABASE_URL does not answer `select 1`: ');
    expect(found?.fix).toBe(
      'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    );
  });
});
