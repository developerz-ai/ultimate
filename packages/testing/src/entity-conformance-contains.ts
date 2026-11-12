// Entity conformance · `contains` on a text column: a case-insensitive substring, over a table whose
// `gin_trgm_ops` index the migration builds (`pg_trgm` created first). `%`, `_` and `\` are found as
// themselves, never wildcards; a term that is no string matches nothing; a sealed column refuses it;
// and `contains` on an array column still means containment, decided by the column's kind.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { arrayOf, entity, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const titles = remember(
  entity('ec_tc_titles', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      title: text({ max: 40 }),
      note: text({ max: 40 }).nullable(),
      secret: text({ max: 40 }).sealed(),
      tags: arrayOf(text({ max: 10 })),
    },
    indexes: [
      { on: ['title'], using: 'gin', operatorClass: 'gin_trgm_ops' },
      { on: ['note'], using: 'gin', operatorClass: 'gin_trgm_ops' },
    ],
  }),
);

const SET = { titles };
type Db = Database<typeof SET>;
const ORG = idAt('a1');

const seed = async (db: Db, rows: readonly (readonly [string, string | null])[]) => {
  await db.titles.insertAll(
    rows.map(([title, note], index) => ({
      id: idAt(`a${100 + index}`),
      orgId: ORG,
      title,
      note,
      secret: 's',
      tags: [title.slice(0, 10)],
    })),
  );
};

/** The titles `contains` finds on `column`, sorted so no driver's order is asserted. */
const found = async (db: Db, column: 'title' | 'note', term: unknown) =>
  (
    await inOrg(ORG, () =>
      db.titles
        .where({ orgId: ORG })
        .andWhere(column, 'contains', term as string)
        .all(),
    )
  )
    .map((row) => row.title)
    .sort();

const checks: readonly EntityDriverCheck[] = [
  checkOver(SET, 'text contains finds a substring in any ASCII case', async (db) => {
    await seed(db, [
      ['Hello World', null],
      ['HELLO', null],
      ['say hello!', null],
      ['help', null],
    ]);
    expect([
      await found(db, 'title', 'hello'),
      await found(db, 'title', 'LLO w'),
      await found(db, 'title', 'xyz'),
    ]).toEqual([['HELLO', 'Hello World', 'say hello!'], ['Hello World'], []]);
  }),
  checkOver(
    SET,
    'text contains folds a non-ASCII letter’s case as every driver does',
    async (db) => {
      await seed(db, [
        ['École', null],
        ['ÉCOLE', null],
        ['STRASSE', null],
      ]);
      expect([await found(db, 'title', 'école'), await found(db, 'title', 'É')]).toEqual([
        ['ÉCOLE', 'École'],
        ['ÉCOLE', 'École'],
      ]);
    },
  ),
  checkOver(
    SET,
    'text contains finds %, _ and \\ as themselves, never as wildcards',
    async (db) => {
      await seed(db, [
        ['100%', null],
        ['100 percent', null],
        ['a_b', null],
        ['axb', null],
        ['back\\slash', null],
        ['backslash', null],
      ]);
      expect([
        await found(db, 'title', '%'),
        await found(db, 'title', '0%'),
        await found(db, 'title', '_'),
        await found(db, 'title', 'a_'),
        await found(db, 'title', '\\'),
        await found(db, 'title', 'k\\s'),
      ]).toEqual([['100%'], ['100%'], ['a_b'], ['a_b'], ['back\\slash'], ['back\\slash']]);
    },
  ),
  checkOver(
    SET,
    'text contains over a nullable column never matches NULL; an empty term matches every value',
    async (db) => {
      await seed(db, [
        ['one', 'Draft'],
        ['two', null],
        ['three', ''],
      ]);
      expect([await found(db, 'note', 'dra'), await found(db, 'note', '')]).toEqual([
        ['one'],
        ['one', 'three'],
      ]);
    },
  ),
  checkOver(
    SET,
    'contains on a sealed column is refused; on an array column it is still containment',
    async (db) => {
      await seed(db, [
        ['alpha', null],
        ['alphabet', null],
      ]);
      const sealed = () =>
        inOrg(ORG, () => db.titles.andWhere('secret' as never, 'contains', 's' as never).all());
      expect(await codeOf(sealed)).toBe('X_ENTITY_SEALED_PREDICATE');
      const tagged = await inOrg(ORG, () =>
        db.titles.andWhere('tags', 'contains', ['alpha']).all(),
      );
      expect(tagged.map((row) => row.title)).toEqual(['alpha']);
    },
  ),
];

export const CONTAINS_CHECKS: readonly EntityDriverCheck[] = checks;
