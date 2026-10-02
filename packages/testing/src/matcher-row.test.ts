// `toEqualRow`: equality that sees the property a repository row does not enumerate. The first
// test is the trap it exists for, reproduced with `toEqual` — if that ever starts passing, Bun
// changed what equality walks and this matcher has nothing left to do.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import './matchers';

const vaults = entity('mr_vaults', {
  columns: { id: uuid().primaryKey(), label: text(), credential: text().sealed() },
});
const table = database({ vaults }, { driver: memoryDriver() }).vaults;

afterAll(() => {
  clearRegistry();
});

/** The assertion's own failure text, or `passed`. */
const failure = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : 'threw a non-error';
  }
  return 'passed';
};

describe('unit · toEqualRow', () => {
  test('the trap: toEqual cannot see a sealed property, either way', async () => {
    const row = await table.insert({ label: 'a', credential: 's3cret' });
    expect(failure(() => expect<unknown>(row).toEqual({ ...row, credential: 's3cret' }))).not.toBe(
      'passed',
    );
    const other = await table.update(row.id, { credential: 'different' });
    expect(failure(() => expect(other).toEqual(row))).toBe('passed');
  });

  test('a row equals a literal that names its secret, and another row holding the same one', async () => {
    const row = await table.insert({ label: 'a', credential: 's3cret' });
    expect(row).toEqualRow({ id: row.id, label: 'a', credential: 's3cret' });
    expect(row).toEqualRow(await table.where({ id: row.id }).one());
    expect([row]).toEqualRow([{ id: row.id, label: 'a', credential: 's3cret' }]);
    expect({ page: { rows: [row] } }).toEqualRow({
      page: { rows: [{ id: row.id, label: 'a', credential: 's3cret' }] },
    });
  });

  test('a wrong or missing secret fails, and the message names the property without its value', async () => {
    const row = await table.insert({ label: 'a', credential: 's3cret' });
    const wrong = failure(() =>
      expect(row).toEqualRow({ id: row.id, label: 'b', credential: 'other-value' }),
    );
    expect(wrong).toContain(
      'credential (server-only): differs — a server-only value is never printed',
    );
    expect(wrong).toContain('label: received "a", expected "b"');
    expect(wrong).not.toContain('s3cret');
    expect(wrong).not.toContain('other-value');
    const missing = failure(() => expect(row).toEqualRow({ id: row.id, label: 'a' }));
    expect(missing).toContain('credential (server-only): the row holds one and the expected');
    const absent = failure(() => expect({ id: row.id, label: 'a' }).toEqualRow(row));
    expect(absent).toContain('credential (server-only): the expected value holds one and the row');
  });

  test('.not, non-rows, a Date and a cycle', async () => {
    const row = await table.insert({ label: 'a', credential: 's3cret' });
    expect(row).not.toEqualRow({ id: row.id, label: 'a', credential: 'nope' });
    expect(failure(() => expect(row).not.toEqualRow(row))).toContain(
      'expected the row not to equal',
    );
    expect(failure(() => expect(null).toEqualRow(row))).toContain('received null, expected');
    expect({ at: new Date(0) }).toEqualRow({ at: new Date(0) });
    expect({ at: new Date(0) }).not.toEqualRow({ at: new Date(1) });
    const loop: Record<string, unknown> = { name: 'a', list: [] as unknown[] };
    loop['self'] = loop;
    (loop['list'] as unknown[]).push(loop['list']);
    const twin: Record<string, unknown> = { name: 'a', list: [] as unknown[] };
    twin['self'] = twin;
    (twin['list'] as unknown[]).push(twin['list']);
    expect(loop).toEqualRow(twin);
  });
});
