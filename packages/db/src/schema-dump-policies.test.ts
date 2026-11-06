// A policy as a dump statement: `public` stays the keyword, a named role is quoted (a role called
// `Public` is not the keyword), and a clause the catalog does not hold is never written.

import { describe, expect, test } from 'bun:test';
import { policyStatement, rowSecurityStatements } from './schema-dump-policies';

describe('policyStatement', () => {
  test('a named role is quoted, public is the keyword, an absent clause is absent', () => {
    const statement = policyStatement({
      table: 'posts',
      name: 'mine',
      permissive: true,
      command: 'insert',
      roles: ['Public', 'public'],
      using: null,
      withCheck: '(id > 0)',
    });
    expect(statement).toBe(
      'create policy "mine" on "posts" as permissive for insert to "Public", public with check ((id > 0));',
    );
  });
});

describe('rowSecurityStatements', () => {
  test('forced without enabled is one statement, never an enable nobody wrote', () => {
    expect(rowSecurityStatements({ table: 'posts', enabled: false, forced: true })).toEqual([
      'alter table "posts" force row level security;',
    ]);
  });
});
