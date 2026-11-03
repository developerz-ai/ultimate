// What the wrappers around a repository owe `lock`: the sealing seam opens the row before the
// callback sees it, append-only and the row observer forward both, and a hand-written driver with
// neither is told what to implement.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { setRowObserver } from './row-observer';

afterAll(() => {
  clearRegistry();
});

const notes = entity('lock_seam_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 10 }) },
});
const ledger = entity('lock_seam_ledger', {
  appendOnly: true,
  columns: { id: uuid().primaryKey(), body: text({ max: 10 }) },
});
const ID = '00000000-0000-7000-8000-000000000001';

describe('unit · the wrappers forward both', () => {
  test('append-only: taken, while a rewrite inside it is still refused', async () => {
    const db = database({ ledger }, { driver: memoryDriver() });
    await db.ledger.insert({ id: ID, body: 'x' });
    const refused = await db.ledger
      .lock(ID, () => db.ledger.update(ID, { body: 'y' }))
      .catch((error: unknown) => error);
    expect(isUltimateError(refused) ? refused.code : refused).toBe('X_ENTITY_APPEND_ONLY');
    expect(await db.ledger.lockKey('k', () => 'held')).toBe('held');
  });

  test('the row observer: both pass through it with one installed', async () => {
    const previous = setRowObserver({ onChange: () => undefined });
    try {
      const db = database({ notes }, { driver: memoryDriver() });
      await db.notes.insert({ id: ID, body: 'x' });
      expect(await db.notes.lock(ID, (row) => row.body)).toBe('x');
      expect(await db.notes.lockKey('k', () => 'held')).toBe('held');
    } finally {
      setRowObserver(previous);
    }
  });
});

describe('unit · a hand-written Repo', () => {
  const { lock: _lock, lockKey: _key, ...bare } = memoryRepo(notes);
  const table = tableFor(notes, bare as Repo<typeof notes.$row>);

  test('lock and lockKey answer X_LOCK_UNSUPPORTED, rejecting rather than throwing', async () => {
    for (const work of [() => table.lock(ID, () => 1), () => table.lockKey('k', () => 1)]) {
      const pending = work();
      const error = await pending.catch((thrown: unknown) => thrown);
      if (!isUltimateError(error)) expect.unreachable('refused');
      expect(error.code).toBe('X_LOCK_UNSUPPORTED');
      expect(error.fix).toContain('postgresDriver()');
    }
  });
});

describe('unit · sealed values', () => {
  const vaults = entity('lock_seam_vaults', {
    columns: { id: uuid().primaryKey(), secret: text().sealed() },
  });

  test('open before the callback sees the row, and stay server-only', async () => {
    const db = database({ vaults }, { driver: memoryDriver() });
    await db.vaults.insert({ id: ID, secret: 'plain' });
    const [secret, wire] = await db.vaults.lock(ID, (row) => [row.secret, JSON.stringify(row)]);
    expect(secret).toBe('plain');
    expect(wire).not.toContain('plain');
    expect(wire).not.toContain('secret');
  });
});
