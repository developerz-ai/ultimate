// Entity conformance · the column matrix through the WRITE PATHS that bind rows their own way:
// `copyAll` (COPY's text format on Postgres — a tab, a newline, a backslash and the word NULL are
// its own syntax), `insertAll({ returning: false })` and `updateMany`. Every row of the matrix,
// written each way, reads back exactly what the reference `memoryDriver()` reads after `insert`.

import { expect } from 'bun:test';
import type { Driver } from '@ultimat3/entity';
import { memoryDriver } from '@ultimat3/entity';
import {
  idFor,
  MATRIX_ROWS,
  type MatrixWrite,
  matrix,
  matrixDb,
} from './entity-conformance-matrix';
import { checkOver } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

/** The row a keyed read answers after `insert`, on memory: what every path must read back. */
const reference = async (write: MatrixWrite) => {
  const db = matrixDb(memoryDriver());
  await db.rows.insert(write);
  return db.rows.where({ id: write.id as string }).one();
};

/** A row naming every scalar and no array: what `updateMany` starts from. */
const base = (id: string, write: MatrixWrite): MatrixWrite => ({
  id,
  label: 'base',
  mood: 'sad',
  count: 0,
  flag: false,
  at: new Date('2000-01-01T00:00:00.000Z'),
  rate: '0',
  day: write.day,
  big: '0',
  data: { plan: 'base', seats: 0 },
});

type Path = (driver: Driver, write: MatrixWrite) => Promise<number>;

const PATHS: Readonly<Record<string, Path>> = {
  copyAll: (driver, write) => matrixDb(driver).rows.copyAll([write]),
  'insertAll({ returning: false })': (driver, write) =>
    matrixDb(driver).rows.insertAll([write], { returning: false }),
  updateMany: async (driver, write) => {
    const db = matrixDb(driver);
    const { id, ...patch } = write;
    if (id === undefined) return expect.unreachable('every matrix row is written with its id');
    await db.rows.insert(base(id, write));
    return db.rows.updateMany([{ id, patch }]);
  },
};

const checks: readonly EntityDriverCheck[] = Object.entries(PATHS).flatMap(([path, run]) =>
  Object.entries(MATRIX_ROWS).map(([name, row], index) =>
    checkOver(
      { matrix },
      `column matrix · ${path} · ${name}: reads back what memory reads back`,
      async (_db, { driver }) => {
        const write = { ...row, id: idFor(index) };
        const expected = await reference(write);
        expect(await run(driver, write)).toBe(1);
        const read = await matrixDb(driver)
          .rows.where({ id: idFor(index) })
          .one();
        expect(read).toEqual(expected);
        // Not two wrong answers agreeing: the reference holds the row as written.
        expect(expected?.label).toBe(write.label);
      },
    ),
  ),
);

export const MATRIX_WRITE_CHECKS: readonly EntityDriverCheck[] = checks;
