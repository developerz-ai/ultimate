// The drift step asks whether migrations describe the app's schema. For an app whose only store is
// a `defineDriver` one, there is no SQL schema to describe: the step says so instead of demanding
// `x db gen "initial"`. Every other shape — Postgres, memory, mixed — still runs it.

import { afterAll, beforeAll, expect, test } from 'bun:test';
// why: Bun has no API to make a unique temporary directory or to remove a directory tree.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun has no API naming the OS temporary directory on every platform.
import { tmpdir } from 'node:os';
import { driftOutcome, nonSqlDriftSkip } from './drift-store';
import { MIGRATIONS_DIR } from './migrations';

let bare: string;
let migrated: string;

beforeAll(async () => {
  bare = mkdtempSync(`${tmpdir()}/drift-store-bare-`);
  migrated = mkdtempSync(`${tmpdir()}/drift-store-migrated-`);
  // `Bun.write` creates the directories on the way.
  await Bun.write(`${migrated}/${MIGRATIONS_DIR}/0001_initial.hash`, 'abc\n');
});

afterAll(() => {
  rmSync(bare, { recursive: true, force: true });
  rmSync(migrated, { recursive: true, force: true });
});

const stores = (sql: readonly string[], custom: readonly string[]) => () => ({ sql, custom });

test('only a custom store, no migration: skipped, naming the store', () => {
  const reason = nonSqlDriftSkip(bare, stores([], ['mongo']));
  expect(reason).toContain('mongo');
});

test('no custom store: the step runs as it always did', () => {
  expect(nonSqlDriftSkip(bare, stores([], []))).toBeUndefined();
});

test('a SQL store beside the custom one: the step runs', () => {
  expect(nonSqlDriftSkip(bare, stores(['postgres'], ['mongo']))).toBeUndefined();
});

test('a migration on disk proves a SQL schema exists: the step runs', () => {
  expect(nonSqlDriftSkip(migrated, stores([], ['mongo']))).toBeUndefined();
});

const finding = (code: string) => ({ code, cause: 'c', fix: 'f', docs: 'd' });

test('skipped: the schema rails never run, the client rail still does', async () => {
  let schemaRan = false;
  const outcome = await driftOutcome(bare, {
    schema: async () => {
      schemaRan = true;
      return [finding('X_DB_DRIFT')];
    },
    client: async () => [finding('X_CLIENT_STALE')],
    stores: stores([], ['mongo']),
  });
  expect(schemaRan).toBe(false);
  expect(outcome.findings.map((each) => each.code)).toEqual(['X_CLIENT_STALE']);
  expect(outcome.ok).toBe(false);
  expect(outcome.output).toContain('mongo');
});

test('not skipped: schema rails first, then the client rail', async () => {
  const outcome = await driftOutcome(bare, {
    schema: async () => [finding('X_DB_DRIFT')],
    client: async () => [finding('X_CLIENT_STALE')],
    stores: stores([], []),
  });
  expect(outcome.findings.map((each) => each.code)).toEqual(['X_DB_DRIFT', 'X_CLIENT_STALE']);
  expect(outcome.output).toBeUndefined();
});
