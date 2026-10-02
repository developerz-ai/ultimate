// A sealed property on a repository row is SERVER-ONLY: read by name, enumerated by nothing. This
// file pins what that buys — every generic serialiser leaves it behind, so a row handed whole to a
// path nobody listed carries no secret — and what it costs, measured: a spread drops it, and
// equality cannot see it. Each cost is a refusal or a documented edit, never a silent leak.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createLogger, isUltimateError, UltimateError } from '@ultimat3/core';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';
import { copyRow, sealedFields, serverOnly } from './sealed';

const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';

const owners = entity('so_owners', {
  columns: { id: uuid().primaryKey(), name: text() },
});

// `credential`, `spare` and `contact`: names no key-based redaction list knows.
const vaults = entity('so_vaults', {
  columns: {
    id: uuid().primaryKey(),
    ownerId: uuid().references(() => owners.id),
    label: text(),
    credential: text().sealed(),
    spare: text().nullable().sealed(),
    contact: text().sealed({ lookup: true }).unique(),
  },
});

const db = database({ owners, vaults }, { driver: memoryDriver() });
let ownerId = '';

beforeAll(async () => {
  ownerId = (await db.owners.insert({ name: 'Ada' })).id;
});

afterAll(() => {
  clearRegistry();
});

const seed = (contact: string, spare: string | null = 'SPARE-CANARY-02c4') =>
  db.vaults.insert({ ownerId, label: 'primary', credential: CANARY, spare, contact });

const LEAK = /CANARY|x1\.[0-9a-f]{16}\./;

describe('unit · a sealed property is server-only', () => {
  test('every read path answers it by name — insert, findById, a page, update', async () => {
    const made = await seed(`${LOOKUP_CANARY}-a`);
    const again = await db.vaults.where({ id: made.id }).one();
    const [paged] = await db.vaults.where({ contact: `${LOOKUP_CANARY}-a` }).all();
    const moved = await db.vaults.update(made.id, { label: 'moved' });
    for (const row of [made, again, paged, moved]) {
      expect(row?.credential).toBe(CANARY);
      expect(row?.spare).toBe('SPARE-CANARY-02c4');
      expect(row?.contact).toBe(`${LOOKUP_CANARY}-a`);
    }
  });

  test('nothing that enumerates a row sees it: JSON, spread, keys, entries, a structured clone', async () => {
    const row = await seed(`${LOOKUP_CANARY}-b`);
    expect(Object.keys(row).sort()).toEqual(['id', 'label', 'ownerId']);
    expect(JSON.stringify(row)).not.toMatch(LEAK);
    expect(JSON.stringify({ nested: [{ row }] })).not.toMatch(LEAK);
    expect(JSON.stringify({ ...row, extra: 1 })).not.toMatch(LEAK);
    expect(JSON.stringify(Object.entries(row))).not.toMatch(LEAK);
    expect(JSON.stringify(Object.assign({}, row))).not.toMatch(LEAK);
    expect(JSON.stringify(structuredClone(row))).not.toMatch(LEAK);
    // A NULL secret is hidden like a value: whether one is set is not for the wire either.
    const bare = await seed(`${LOOKUP_CANARY}-c`, null);
    expect(bare.spare).toBeNull();
    expect(Object.hasOwn(bare, 'spare')).toBe(true);
    expect(JSON.stringify(bare)).not.toContain('spare');
  });

  test('a log line and an error carrying the row carry no secret', async () => {
    const row = await seed(`${LOOKUP_CANARY}-d`);
    const lines: string[] = [];
    const log = createLogger({ level: 'info', writer: (line) => lines.push(line) });
    log.info('vault.read', { row, rows: [row] });
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).toContain('primary');
    expect(lines.join('\n')).not.toMatch(LEAK);

    class VaultError extends UltimateError {}
    const error = new VaultError({
      code: 'X_INVARIANT',
      cause: 'a vault row rode on an error',
      fix: 'x errors explain X_INVARIANT --json',
      meta: { row },
    });
    expect(JSON.stringify(error.toJSON())).toContain('primary');
    expect(JSON.stringify(error.toJSON())).not.toMatch(LEAK);
    log.error('vault.failed', { error });
    expect(lines.join('\n')).not.toMatch(LEAK);
  });

  test('a row passed back whole is written whole: the property is own, so the seam still seals it', async () => {
    const row = await seed(`${LOOKUP_CANARY}-e`);
    const kept = await db.vaults.update(row.id, row);
    expect(kept.credential).toBe(CANARY);
    expect(kept.contact).toBe(`${LOOKUP_CANARY}-e`);
  });
});

describe('unit · what server-only costs, measured', () => {
  test('a spread patch leaves the stored secret alone — an absent property is not a write', async () => {
    const row = await seed(`${LOOKUP_CANARY}-f`);
    const moved = await db.vaults.update(row.id, { ...row, label: 'renamed' });
    expect(moved.label).toBe('renamed');
    expect(moved.credential).toBe(CANARY);
    expect(moved.spare).toBe('SPARE-CANARY-02c4');
  });

  test('a spread INSERT or UPSERT of a required secret is refused, naming the spread and the rewrite', async () => {
    const row = await seed(`${LOOKUP_CANARY}-h`);
    const { id: _id, ...clone } = row;
    const refusal = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
      } catch (error) {
        return isUltimateError(error) ? `${error.code} | ${error.cause} | ${error.fix}` : 'uncoded';
      }
      return 'resolved';
    };
    const inserted = await refusal(() => db.vaults.insert({ ...clone, label: 'clone' }));
    expect(inserted).toStartWith(
      'X_INVARIANT_VIOLATED | so_vaults.credential: is required, sealed, and missing from the row',
    );
    expect(inserted).toContain('a spread ({ ...row })');
    expect(inserted).toContain('| { ...row, credential: row.credential }');
    expect(await refusal(() => db.vaults.insertAll([{ ...clone, label: 'clone' }]))).toBe(inserted);
    // A hand-held repository has no `$parse` in front of it: the seam refuses in the same words.
    const byHand = { ...clone, id: '0198c1a0-0000-7000-8000-0000000000aa', label: 'clone' };
    expect(await refusal(() => memoryRepo(vaults).insert(byHand))).toBe(inserted);
    // An explicit `null` is a different mistake, and keeps the words it always had.
    expect(
      await refusal(() => db.vaults.insert({ ...clone, credential: null as unknown as string })),
    ).toContain('is required and has no default');
    // An upsert row is an insert candidate first, so the same refusal — and the stored row is
    // exactly as it was.
    expect(
      await refusal(() =>
        db.vaults.upsertAll([{ ...row, label: 'upserted' }], { onConflict: ['id'] }),
      ),
    ).toBe(inserted);
    const stored = await db.vaults.where({ id: row.id }).one();
    expect([stored?.label, stored?.credential]).toEqual(['primary', CANARY]);
    // The edit that copies it: the secret named, which is the one read there is.
    const copied = await db.vaults.insert({
      ...clone,
      label: 'clone',
      credential: row.credential,
      spare: row.spare,
      contact: `${LOOKUP_CANARY}-h2`,
    });
    expect(copied.credential).toBe(CANARY);
  });

  test('a row passed WHOLE round-trips: insert(row) and update(id, row) write what it holds, a null included', async () => {
    const row = await seed(`${LOOKUP_CANARY}-n`);
    await db.vaults.delete(row.id);
    const again = await db.vaults.insert(row);
    expect([again.credential, again.spare, again.contact]).toEqual([
      CANARY,
      'SPARE-CANARY-02c4',
      `${LOOKUP_CANARY}-n`,
    ]);
    // A whole row whose nullable secret is null CLEARS the stored one; a spread of it would not.
    const cleared = serverOnly(sealedFields(vaults), { ...copyRow(again), spare: null });
    expect((await db.vaults.update(again.id, cleared)).spare).toBeNull();
    // …and a secret changed on the row is the secret written.
    const edited: { -readonly [K in keyof typeof again]: (typeof again)[K] } = copyRow(again);
    edited.credential = 'ROTATED-CANARY-55d0';
    expect((await db.vaults.update(again.id, edited)).credential).toBe('ROTATED-CANARY-55d0');
  });

  test('a spread insert of a NULLABLE secret stores NULL — the one copy that is silent', async () => {
    const row = await seed(`${LOOKUP_CANARY}-m`);
    const { id: _id, ...clone } = row;
    const copied = await db.vaults.insert({
      ...clone,
      credential: row.credential,
      contact: `${LOOKUP_CANARY}-m2`,
    });
    expect(row.spare).toBe('SPARE-CANARY-02c4');
    expect(copied.spare).toBeNull();
  });

  test('equality cannot see it: toEqual compares enumerable properties, so assert a secret by name', async () => {
    const row = await seed(`${LOOKUP_CANARY}-i`);
    // `expect<unknown>`: the matcher is typed by the ROW, which still declares the secret — so the
    // literal that passes is one the types would refuse, and the one they accept fails.
    expect<unknown>(row).toEqual({ id: row.id, ownerId, label: 'primary' });
    expect(row).toMatchObject({ credential: CANARY });
    expect(row).toHaveProperty('credential', CANARY);
  });

  test('preload() keeps it on the row a relation is attached to', async () => {
    const row = await seed(`${LOOKUP_CANARY}-j`);
    const [loaded] = await db.vaults
      .where({ contact: `${LOOKUP_CANARY}-j` })
      .preload('owner')
      .all();
    expect(loaded?.id).toBe(row.id);
    expect(loaded?.owner).toMatchObject({ name: 'Ada' });
    expect(loaded?.credential).toBe(CANARY);
    expect(JSON.stringify(loaded)).not.toMatch(LEAK);
  });
});

describe('unit · a projection that names it', () => {
  test('select() naming a sealed column answers the plaintext by name', async () => {
    const row = await seed(`${LOOKUP_CANARY}-k`);
    const picked = await db.vaults
      .where({ id: row.id })
      .select({ id: true, credential: true })
      .one();
    expect(picked?.credential).toBe(CANARY);
  });

  test('…and that row serialises without it, like every other repository row', async () => {
    const row = await seed(`${LOOKUP_CANARY}-l`);
    const picked = await db.vaults
      .where({ id: row.id })
      .select({ id: true, credential: true })
      .one();
    expect(JSON.stringify(picked)).not.toMatch(LEAK);
  });
});

describe('unit · serverOnly() and copyRow()', () => {
  const fields = sealedFields(vaults);

  test('hides only what the row has, and prefers the opened value', () => {
    const stored = { id: 'i', label: 'l', credential: 'x1.stored', spare: null };
    const row = serverOnly(fields, stored, { credential: 'opened' });
    expect(row.credential).toBe('opened');
    expect(row.spare).toBeNull();
    // A projection that left `contact` out leaves it out: nothing is invented.
    expect(Object.hasOwn(row, 'contact')).toBe(false);
    expect(Object.keys(row)).toEqual(['id', 'label']);
    // The stored object is the driver's, and stays as it was.
    expect(Object.keys(stored)).toEqual(['id', 'label', 'credential', 'spare']);
  });

  test('the property stays writable and configurable — server code may still set it', () => {
    const row = serverOnly(fields, { id: 'i', credential: 'a' });
    row.credential = 'b';
    expect(row.credential).toBe('b');
    expect(Object.keys(row)).toEqual(['id']);
  });

  test('copyRow keeps what a spread drops, and is a spread for every other row', () => {
    const row = serverOnly(fields, { id: 'i', label: 'l', credential: 'kept' });
    const copy = copyRow(row);
    expect(copy).not.toBe(row);
    expect(copy.credential).toBe('kept');
    expect(Object.keys(copy)).toEqual(['id', 'label']);
    expect({ ...row }.credential).toBeUndefined();
    expect(copyRow({ a: 1, b: [2] })).toEqual({ a: 1, b: [2] });
  });
});
