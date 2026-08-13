// Single responsibility: the identity two detectors group statements by. It is one rule precisely
// because `x dev`'s ledger and `@ultimat3/testing`'s strict fixture must never disagree about
// whether a statement is the same one again — so these are the cases both inherit.

import { describe, expect, test } from 'bun:test';
import type { StatementEvent } from './observe';
import { statementFingerprint, statementKind, statementVerb } from './statement-shape';
import { statementSpanName } from './statement-span';

const event = (text: string, attribution?: { entity: string; op: string }): StatementEvent => ({
  text,
  values: [],
  durationMs: 1,
  rows: 1,
  ...(attribution === undefined ? {} : { attribution }),
});

describe('unit · statementVerb', () => {
  test('is the first word, lowercased, whatever the statement is indented with', () => {
    expect(statementVerb('  \n SELECT "id" from "members"')).toBe('select');
    expect(statementVerb('Insert into "members" values ($1)')).toBe('insert');
  });

  test('is empty when a statement opens with anything but a word', () => {
    expect(statementVerb('/* app: feed */ select 1')).toBe('');
    expect(statementVerb('(select 1)')).toBe('');
    expect(statementVerb('')).toBe('');
  });

  test('the span name is the same read, so a verbless statement is db.statement, not `db.`', () => {
    expect(statementSpanName('/* app: feed */ select 1')).toBe('db.statement');
    expect(statementSpanName('SELECT 1')).toBe('db.select');
  });
});

describe('unit · statementKind', () => {
  test('the write verbs write', () => {
    for (const verb of ['insert', 'update', 'delete', 'upsert', 'merge', 'truncate', 'copy']) {
      expect(statementKind(`${verb} whatever`)).toBe('write');
    }
  });

  test('everything else reads, a CTE over an insert included', () => {
    expect(statementKind('select 1')).toBe('read');
    expect(statementKind('begin')).toBe('read');
    // Naming `insertAll` in the fix for a loop of `with … select` would be wrong more often than
    // naming `preload` for one that writes — the leading verb decides, never a nested one.
    expect(
      statementKind('with rows as (insert into "t" values (1) returning *) select * from rows'),
    ).toBe('read');
  });

  test('a statement with no verb reads, so a fix never tells an author to batch a comment', () => {
    expect(statementKind('/* warmup */ select 1')).toBe('read');
  });
});

describe('unit · statementFingerprint', () => {
  test('an attributed statement is its entity and op — the report an author can act on', () => {
    expect(
      statementFingerprint(
        event('select "id" from "m" where "id" = $1', {
          entity: 'members',
          op: 'findById',
        }),
      ),
    ).toBe('members.findById');
  });

  test('two texts of one shape are one fingerprint however they were indented', () => {
    expect(statementFingerprint(event('select "id"\n  from "members"\n'))).toBe(
      statementFingerprint(event('select "id" from "members"')),
    );
  });

  test('one entity read two ways is two shapes, and two entities one way are two more', () => {
    const findById = event('select 1', { entity: 'members', op: 'findById' });
    expect(statementFingerprint(findById)).not.toBe(
      statementFingerprint(event('select 1', { entity: 'members', op: 'findMany' })),
    );
    expect(statementFingerprint(findById)).not.toBe(
      statementFingerprint(event('select 1', { entity: 'posts', op: 'findById' })),
    );
  });

  test('unattributed statements group by text, so two entities of one SQL are still one shape', () => {
    // What the fallback costs, stated rather than hidden: nothing above hand-written SQL names an
    // entity, so identical text is identical work as far as any detector can tell.
    expect(statementFingerprint(event('select 1'))).toBe(statementFingerprint(event('select 1')));
  });
});
