// A read's row is what a client decodes, so a member it loses or stops being promised breaks it,
// and a member it gains does not: an entity gaining a column must not flip every
// `rows: X.$schema` read to breaking, which is what `canonicalJson` inequality would do.

import { describe, expect, test } from 'bun:test';
import { diffManifest } from './diff';
import type { ChangeKind, ManifestChange } from './diff-change';
import { fixtureManifest, fixtureQuery } from './diff-fixture';
import { diffRows } from './diff-rows';
import type { JsonValue, QueryFact } from './schema';

const ROW = {
  type: 'object',
  required: ['id', 'title'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    note: { type: 'string' },
    author: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
    tags: {
      type: 'array',
      items: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
    },
  },
} as const;

const only = (changes: readonly ManifestChange[]): readonly [ChangeKind, string][] =>
  changes.map((change) => [change.kind, change.path]);

const diff = (after: JsonValue): readonly [ChangeKind, string][] =>
  only(diffRows('rows', ROW, after));

const withProperties = (properties: Record<string, JsonValue>): JsonValue => ({
  ...ROW,
  properties: { ...ROW.properties, ...properties },
});

describe('unit · a row member added is additive', () => {
  test('optional or required: a client written against the old row reads the new one', () => {
    expect(diff(withProperties({ extra: { type: 'string' } }))).toEqual([
      ['additive', 'rows.extra'],
    ]);
    expect(
      diff({
        ...ROW,
        required: ['id', 'title', 'extra'],
        properties: { ...ROW.properties, extra: { type: 'string' } },
      }),
    ).toEqual([['additive', 'rows.extra']]);
  });

  test('inside a nested object, and inside an array of them', () => {
    expect(
      diff(
        withProperties({
          author: {
            ...ROW.properties.author,
            properties: { name: { type: 'string' }, bio: { type: 'string' } },
          },
        }),
      ),
    ).toEqual([['additive', 'rows.author.bio']]);
    expect(
      diff(
        withProperties({
          tags: {
            type: 'array',
            items: {
              ...ROW.properties.tags.items,
              properties: { slug: { type: 'string' }, hue: { type: 'string' } },
            },
          },
        }),
      ),
    ).toEqual([['additive', 'rows.tags[].hue']]);
  });
});

describe('unit · a promise withdrawn is breaking', () => {
  test('a member removed', () => {
    const { note: _note, ...properties } = ROW.properties;
    expect(diff({ ...ROW, properties })).toEqual([['breaking', 'rows.note']]);
  });

  test('a member retyped', () => {
    expect(diff(withProperties({ title: { type: 'number' } }))).toEqual([
      ['breaking', 'rows.title'],
    ]);
  });

  test('a member now nullable: a client decoding a string meets a null', () => {
    expect(
      diff(withProperties({ title: { anyOf: [{ type: 'string' }, { type: 'null' }] } })),
    ).toEqual([['breaking', 'rows.title']]);
  });

  test('required became optional', () => {
    expect(diffRows('rows', ROW, { ...ROW, required: ['id'] })).toEqual([
      { kind: 'breaking', path: 'rows.title', detail: 'row member no longer required' },
    ]);
  });

  test('a nested member removed', () => {
    expect(diff(withProperties({ author: { ...ROW.properties.author, properties: {} } }))).toEqual([
      ['breaking', 'rows.author.name'],
    ]);
  });

  test('a member that stopped being an object cannot be walked: retyped', () => {
    expect(diff(withProperties({ author: { type: 'string' } }))).toEqual([
      ['breaking', 'rows.author'],
    ]);
  });
});

describe('unit · what no caller decodes', () => {
  test('optional became required is a stronger promise, reported as additive', () => {
    expect(diff({ ...ROW, required: ['id', 'title', 'note'] })).toEqual([
      ['additive', 'rows.note'],
    ]);
  });

  test('`required` reordered is no change: it is a set', () => {
    expect(diff({ ...ROW, required: ['title', 'id'] })).toEqual([]);
  });

  test('a description moved is internal, never breaking', () => {
    expect(
      diff(withProperties({ title: { type: 'string', description: 'the headline' } })),
    ).toEqual([['internal', 'rows.title']]);
  });
});

describe('unit · through diffQueries', () => {
  const read = (rows?: JsonValue): QueryFact => {
    const { rows: _fixture, ...fact } = fixtureQuery('feed', 'feed:read');
    return rows === undefined ? fact : { ...fact, rows };
  };
  const rowPaths = (before: QueryFact, after: QueryFact): readonly [ChangeKind, string][] =>
    only(
      diffManifest(
        fixtureManifest({ queries: [before] }),
        fixtureManifest({ queries: [after] }),
      ).changes.filter((change) => change.path.includes('.rows')),
    );

  test('a member removed fails the gate, at the path of the read', () => {
    const { note: _note, ...properties } = ROW.properties;
    expect(rowPaths(read(ROW), read({ ...ROW, properties }))).toEqual([
      ['breaking', 'queries.feed.rows.note'],
    ]);
  });

  test('a member added does not', () => {
    expect(rowPaths(read(ROW), read(withProperties({ extra: { type: 'string' } })))).toEqual([
      ['additive', 'queries.feed.rows.extra'],
    ]);
  });

  // `before` carrying `rows` proves its writer knew the field, and `after` is always this build:
  // a row gone from it is the published 200 falling back to `items: {}`, a typed client broken.
  test('a row dropped, or no longer introspectable, is breaking', () => {
    expect(rowPaths(read(ROW), read())).toEqual([['breaking', 'queries.feed.rows']]);
  });

  // The reverse is ambiguous (a file older than the field, or a row newly declared) and widens
  // nothing either way, so it is reported and never fails the gate.
  test('a row appearing is additive', () => {
    expect(rowPaths(read(), read(ROW))).toEqual([['additive', 'queries.feed.rows']]);
  });
});
