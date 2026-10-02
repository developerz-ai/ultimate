// The list half of a resource declaration, normalised: computed columns, and what is refused
// where it is written. (Scopes and the row scope are `list-scopes.test.ts` and `row-scope.test.ts`.)

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { AdminActor } from './authz';
import type { AdminRow } from './registry';
import { adminResource } from './resource';
import {
  ADMIN_RENDERERS,
  type AdminComputedColumnOptions,
  computedColumnsOf,
  rowScopeOf,
  scopesOf,
} from './resource-list';

const notes = entity('admin_decl_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    pin: text({ max: 8 }).sealed().nullable(),
  },
});

afterAll(clearRegistry);

const declared = { name: notes.$name, entity: notes };
const ACTOR: AdminActor = { id: 'ana' };

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return expect.unreachable('nothing was refused');
};

describe('unit · computed columns', () => {
  test('declaration order, a default label key, and the app’s own row type restored', () => {
    interface Note extends AdminRow {
      readonly title: string;
    }
    const columns = computedColumnsOf<Note>(declared, {
      shout: { value: (row) => row.title.toUpperCase(), render: 'truncate' },
      named: { value: (row) => row.title, render: 'badge', labelKey: 'notes.named' },
      custom: { value: (row) => row.title, render: (props) => `${String(props.value)}!` },
    });
    expect(columns.map((column) => [column.name, column.labelKey])).toEqual([
      ['shout', 'admin.admin_decl_notes.column.shout'],
      ['named', 'notes.named'],
      ['custom', 'admin.admin_decl_notes.column.custom'],
    ]);
    expect(columns[0]?.value({ title: 'hi' })).toBe('HI');
    const render = columns[2]?.render;
    expect(
      typeof render === 'function' &&
        render({ value: 'x', row: {}, ctx: { timeZone: 'UTC', locale: 'en' } }),
    ).toBe('x!');
    expect(computedColumnsOf(declared, undefined)).toEqual([]);
  });

  test('a name that is also an entity column is refused — sealed ones included', () => {
    for (const name of ['title', 'pin']) {
      expect(
        codeOf(() => computedColumnsOf(declared, { [name]: { value: () => 1, render: 'json' } })),
      ).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    }
    expect(() =>
      adminResource(notes, { columns: { title: { value: () => 1, render: 'json' } } }),
    ).toThrow(/is declared in `columns:` and is also a column of the entity/);
  });

  test('a renderer that is not one of the six is refused, naming the six', () => {
    const odd = { value: () => 1, render: 'sparkline' } as unknown as AdminComputedColumnOptions;
    expect(() => computedColumnsOf(declared, { trend: odd })).toThrow(
      new RegExp(
        `names a renderer the admin does not have \\(it has: ${ADMIN_RENDERERS.join(', ')}\\)`,
      ),
    );
  });
});

describe('unit · scopes and the row scope, normalised', () => {
  test('a scope’s label key defaults, and an actor-dependent where is checked on every call', () => {
    const [mine] = scopesOf(
      declared,
      {
        mine: {
          where: (actor) => [{ field: actor.id === 'ana' ? 'title' : 'pin', op: 'eq', value: 'x' }],
        },
      },
      undefined,
    );
    expect(mine?.labelKey).toBe('admin.admin_decl_notes.scope.mine');
    expect(mine?.where(ACTOR)).toEqual([{ field: 'title', op: 'eq', value: 'x' }]);
    // The same declaration, another actor, a sealed column: refused when it is ASKED.
    expect(codeOf(() => mine?.where({ id: 'bo' }))).toBe('X_ADMIN_FILTER_INVALID');
    expect(scopesOf(declared, undefined, undefined)).toEqual([]);
  });

  test('an operator the admin does not have is refused in a declared predicate', () => {
    const odd = [{ field: 'title', op: 'between', value: 'x' }] as unknown as Parameters<
      typeof scopesOf
    >[1];
    expect(() => scopesOf(declared, { odd: { where: odd as never } }, undefined)).toThrow(
      /names an operator the admin does not have/,
    );
  });

  test('no `rows` is no row scope — absent, never an empty function', () => {
    expect(rowScopeOf(declared, undefined)).toBeUndefined();
    expect(rowScopeOf(declared, () => [])?.(ACTOR)).toEqual([]);
  });
});
