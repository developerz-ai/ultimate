import { describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import {
  DEFAULT_SEARCH_COLUMN,
  isSearchLanguage,
  SEARCH_LANGUAGES,
  SEARCH_PROPERTY,
  searchExpression,
} from './search';

describe('SEARCH_LANGUAGES', () => {
  test('is the closed set the DDL may name, and English is in it', () => {
    expect(SEARCH_LANGUAGES.includes('english')).toBe(true);
    expect(isSearchLanguage('english')).toBe(true);
    // The whole point: a language is never taken from a value, so an unknown one is refused.
    expect(isSearchLanguage("english'); drop table posts; --")).toBe(false);
    expect(isSearchLanguage('constructor')).toBe(false);
  });
});

describe('searchExpression', () => {
  test('weights every source and coalesces every null, in declaration order', () => {
    expect(
      searchExpression('english', [
        { column: 'title', weight: 'A' },
        { column: 'body', weight: 'D' },
      ]),
    ).toBe(
      `setweight(to_tsvector('english', coalesce("title", '')), 'A') || ` +
        `setweight(to_tsvector('english', coalesce("body", '')), 'D')`,
    );
  });
});

describe('entity() · $search', () => {
  test('is null when no column is searchable', () => {
    const plain = entity('search_plain', {
      columns: { id: uuid().primaryKey(), orgId: uuid(), title: text() },
    });
    expect(plain.$search).toBeNull();
  });

  test('derives one vector column and one GIN index from the searchable columns', () => {
    const posts = entity('search_posts', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid(),
        title: text().searchable('A'),
        body: text().nullable().searchable(),
      },
    });
    const vector = posts.$search;
    expect(vector).not.toBeNull();
    expect(vector?.column).toBe(DEFAULT_SEARCH_COLUMN);
    expect(vector?.language).toBe('english');
    expect(vector?.sources).toEqual([
      { column: 'title', weight: 'A' },
      { column: 'body', weight: 'D' },
    ]);
    const gin = posts.$indexes.filter((index) => index.using === 'gin');
    expect(gin).toHaveLength(1);
    expect(gin[0]?.columns).toEqual([DEFAULT_SEARCH_COLUMN]);
    expect(gin[0]?.unique).toBe(false);
  });

  test('the vector column is described as a generated, not-null tsvector', () => {
    const posts = entity('search_described', {
      columns: { id: uuid().primaryKey(), title: text().searchable() },
    });
    const described = posts.$describe().columns.find((c) => c.column === DEFAULT_SEARCH_COLUMN);
    expect(described?.kind).toBe('tsvector');
    expect(described?.notNull).toBe(true);
    expect(described?.generated).toBe(
      `setweight(to_tsvector('english', coalesce("title", '')), 'D')`,
    );
  });

  test('the vector column is not a row property — the row type is unchanged', () => {
    const posts = entity('search_row', {
      columns: { id: uuid().primaryKey(), title: text().searchable() },
    });
    expect(Object.keys(posts.$columns)).toEqual(['id', 'title']);
    expect(SEARCH_PROPERTY.startsWith('$')).toBe(true);
  });

  test('refuses a searchable column that is not text', () => {
    expect(() => uuid().searchable()).toThrow(/searchable/);
  });

  test('refuses a declared column already occupying the vector column name', () => {
    expect(() =>
      entity('search_collide', {
        columns: {
          id: uuid().primaryKey(),
          title: text().searchable(),
          searchTsv: text(),
        },
      }),
    ).toThrow(/search_tsv/);
  });

  test('a declared language other than the default reaches the expression', () => {
    const posts = entity('search_french', {
      columns: { id: uuid().primaryKey(), title: text().searchable() },
      search: { language: 'french' },
    });
    expect(posts.$search?.language).toBe('french');
    expect(posts.$search?.expression).toContain("to_tsvector('french'");
  });
});
