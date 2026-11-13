// The table positions of one statement, and nothing else: a column or a SET target spelled like a
// table is no read of it, a comma list after `from` names each table, `using` is a table position.

import { describe, expect, test } from 'bun:test';
import { statementTables } from './sql-tables';
import { testName } from './test-types';

describe(testName('unit', 'statementTables'), () => {
  test('each clause and each name of a comma list, last part of a qualified name, lowercased', () => {
    expect(
      statementTables(
        'select * from "public"."Posts" p, orgs as o join members m on true; delete from a using b',
      ),
    ).toEqual(['posts', 'orgs', 'members', 'a', 'b']);
  });

  test('a column, a SET target and a column list are not tables', () => {
    expect(statementTables('select posts from notes')).toEqual(['notes']);
    expect(statementTables('update notes set posts = 1, orgs = 2')).toEqual(['notes']);
    expect(statementTables('insert into notes (posts, orgs) values (1, 2)')).toEqual(['notes']);
    expect(statementTables('select * from notes where id in (1, 2)')).toEqual(['notes']);
  });
});
