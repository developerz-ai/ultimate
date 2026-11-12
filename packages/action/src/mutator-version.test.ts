// A mutator over an entity that declares `version`: the client's read carries the version in the
// mutator's input, the server half hands it to `update`, and a second writer from the same read is
// refused with `X_ENTITY_STALE` — a 409, the status that tells the client to re-read and retry.
// No mutator option exists for this: the version is a column of the row, carried as one.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, UltimateError, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { statusFor } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { mutator } from './mutator';

const notes = entity('mutator_version_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 80 }), lockVersion: integer().default(0) },
  version: 'lockVersion',
});

afterAll(() => {
  clearRegistry();
});

const ID = '00000000-0000-7000-8000-00000000e014';
const ctx = ctxOf({ actor: userActor({ id: 'u1' }) });

interface NoteRow {
  readonly id: string;
  readonly body: string;
}

const renameWith = (db: ReturnType<typeof database<{ notes: typeof notes }>>, carry: boolean) =>
  mutator({
    input: t.object({ id: t.uuid, body: t.string.max(80), lockVersion: t.number.int() }),
    output: t.object({ id: t.uuid, lockVersion: t.number.int() }),
    policy: allow(),
    idempotent: true,
    conflict: 'server-wins',
    local(tx, { id, body }) {
      tx.table<NoteRow>('notes').update(id, { body });
    },
    async server(_ctx, { id, body, lockVersion }) {
      const row = await db.notes.update(id, carry ? { body, lockVersion } : { body });
      return { id: row.id, lockVersion: row.lockVersion };
    },
  }).named('renameNote');

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'resolved';
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
};

describe('mutator · an entity version lock', () => {
  test('the version rides in the input; a second write from the same read is a 409', async () => {
    const db = database({ notes }, { driver: memoryDriver() });
    await db.notes.insert({ id: ID, body: 'draft' });
    const rename = renameWith(db, true);
    expect(await rename.server(ctx, { id: ID, body: 'first', lockVersion: 0 })).toEqual({
      id: ID,
      lockVersion: 1,
    });
    const stale = await codeOf(() =>
      rename.server(ctx, { id: ID, body: 'second', lockVersion: 0 }),
    );
    expect(stale).toBe('X_ENTITY_STALE');
    expect(statusFor(stale)).toBe(409);
    expect((await db.notes.where({ id: ID }).one())?.body).toBe('first');
  });

  test('a server half that drops the version is refused rather than overwriting', async () => {
    const db = database({ notes }, { driver: memoryDriver() });
    await db.notes.insert({ id: ID, body: 'draft' });
    const blind = renameWith(db, false);
    expect(await codeOf(() => blind.server(ctx, { id: ID, body: 'x', lockVersion: 0 }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
  });
});
