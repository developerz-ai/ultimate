// `readByIds`' bisect, driven through a scripted client: a value the server refuses fails only the
// id that carried it, and a half that fails for a reason of its own answers THAT reason — only a
// transaction the first refusal aborted (`25P02`) inherits the first refusal.

import { afterAll, describe, expect, test } from 'bun:test';
import type { DbClient, SqlFragment } from '@ultimat3/db';
import { type PointRead, readByIds } from './batch-read';
import { text } from './columns';
import { bigint } from './columns-data';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const rows = entity('batch_read_bisect_rows', {
  columns: { id: bigint().primaryKey(), label: text({ max: 8 }) },
});

const serverError = (code: string) => ({ severity: 'ERROR', code, message: `refused ${code}` });

const BAD = 'abc';
const IDS: readonly string[] = ['1', '2', '3', BAD];
const isId = (value: unknown): value is string => typeof value === 'string' && IDS.includes(value);

/** A client whose answer to each statement is `answer(ids)`: rows, or a thrown server error. */
const scripted = (answer: (ids: readonly unknown[]) => unknown): DbClient => {
  const query = async <T>(fragment: SqlFragment): Promise<readonly T[]> => {
    const out = answer(fragment.values.flat().filter(isId));
    if (Array.isArray(out)) return out;
    throw out;
  };
  return {
    query,
    one: async () => null,
    execute: async () => 0,
  };
};

const read = (client: DbClient): PointRead<typeof rows.$row> => ({
  entity: rows,
  client,
  scoped: { entity: rows.$name, where: [], orderBy: [], limit: 1 },
  shape: { includeDeleted: false },
  key: { property: 'id', column: 'id', kind: 'bigint' },
});

describe('readByIds bisect', () => {
  test('a half that fails for a connection reason answers that reason, not the first refusal', async () => {
    const failover = serverError('57P01');
    const client = scripted((ids) => {
      if (ids.includes(BAD)) return serverError('22P02');
      if (ids.includes('1')) return failover;
      return ids.map((id) => ({ id, label: 'x' }));
    });
    const answers = await readByIds(read(client), IDS);
    expect(answers.get('1')).toEqual({ error: failover });
    expect(answers.get('2')).toEqual({ error: failover });
    expect(answers.get(BAD)).toEqual({ error: serverError('22P02') });
  });

  test('a half the first refusal aborted (25P02) is answered with that first refusal', async () => {
    const first = serverError('22P02');
    let sent = 0;
    const client = scripted(() => {
      sent += 1;
      return sent === 1 ? first : serverError('25P02');
    });
    const answers = await readByIds(read(client), IDS);
    for (const id of IDS) expect(answers.get(id)).toEqual({ error: first });
  });
});
