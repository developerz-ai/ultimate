// The relations as query time reaches them: off the registry, not off a list a caller assembled.
// A preload names its relation with a string, so the lookup and its refusal are what matter here —
// a name nobody can spell is a relation nobody can preload.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { EntityError } from './errors';
import { clearRegistry, getEntity } from './registry';
import { relationMap, relationNamed, relationsFor } from './relations';

// The map projects the WHOLE registry, so this file owns the registry for its duration: an entity
// another file left behind would show up in the assertions below as one more key.
clearRegistry();

const authors = entity('relation_map_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const books = entity('relation_map_books', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    title: text({ max: 120 }),
  },
});

afterAll(() => {
  clearRegistry();
});

const caught = (run: () => unknown): EntityError | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof EntityError ? error : undefined;
  }
  return undefined;
};

describe('the resolved foreign keys the map is built from', () => {
  test('the entity and its registry entry read one foreign key, not two', () => {
    expect(books.$references()).toEqual([
      {
        property: 'authorId',
        column: 'author_id',
        nullable: false,
        targetEntity: 'relation_map_authors',
        targetProperty: 'id',
        targetColumn: 'id',
      },
    ]);
    expect(getEntity(books.$name)?.references()).toEqual(books.$references());
  });

  test('the string a migration reads renders the record a traversal reads', () => {
    const column = books.$describe().columns.find((one) => one.property === 'authorId');
    expect(column?.references).toBe('relation_map_authors.id');
  });
});

describe('relationMap()', () => {
  test('covers every registered entity without being handed one', () => {
    expect(Object.keys(relationMap())).toEqual(['relation_map_authors', 'relation_map_books']);
    expect(relationMap().relation_map_authors?.relation_map_books?.kind).toBe('hasMany');
  });

  test('answers a second read from the memo while the registry is unchanged', () => {
    expect(relationMap()).toBe(relationMap());
  });

  test('rebuilds when a schema module registers an entity after the first read', () => {
    const before = relationMap();
    const reviews = entity('relation_map_reviews', {
      columns: { id: uuid().primaryKey(), bookId: uuid().references(() => books.id) },
    });
    expect(before.relation_map_books?.relation_map_reviews).toBeUndefined();
    expect(relationMap()).not.toBe(before);
    expect(relationMap()[books.$name]?.relation_map_reviews?.kind).toBe('hasMany');
    expect(relationMap()[reviews.$name]?.book?.to).toBe('relation_map_books');
  });
});

describe('relationsFor() and relationNamed()', () => {
  test("reads one entity's own relations off the registry", () => {
    expect(relationsFor(books.$name).author).toMatchObject({
      kind: 'belongsTo',
      from: 'relation_map_books',
      to: 'relation_map_authors',
      localKey: 'authorId',
      remoteKey: 'id',
    });
  });

  test('an entity nobody registered has no relations rather than an error', () => {
    expect(relationsFor('relation_map_absent')).toEqual({});
  });

  test('returns the relation the caller named', () => {
    expect(relationNamed(books.$name, 'author').remoteColumn).toBe('id');
  });

  test('refuses an unknown name with the call that reads a declared one', () => {
    const error = caught(() => relationNamed(books.$name, 'writer'));
    expect(error).toBeUltimateError('X_PRELOAD_UNKNOWN_RELATION');
    expect(error?.cause).toContain('"writer"');
    expect(error?.fix).toContain(`relationNamed('${books.$name}', 'author')`);
  });

  test('the fix runs: pasting it back returns the relation it names', () => {
    const error = caught(() => relationNamed(books.$name, 'writer'));
    const [, entityName, relation] = error?.fix.match(/relationNamed\('(\w+)', '(\w+)'\)/) ?? [];
    expect(relationNamed(entityName ?? '', relation ?? '').name).toBe('author');
  });

  test('carries the names the pasted call does not, and no comment when there are none', () => {
    const singles = entity('relation_map_singles', {
      columns: { id: uuid().primaryKey(), bookId: uuid().references(() => books.id) },
    });
    expect(caught(() => relationNamed(singles.$name, 'nope'))?.fix).not.toContain('#');
    const shelves = entity('relation_map_shelves', {
      columns: {
        id: uuid().primaryKey(),
        bookId: uuid().references(() => books.id),
        ownerId: uuid().references(() => authors.id),
      },
    });
    expect(caught(() => relationNamed(shelves.$name, 'nope'))?.fix).toContain('   # or: owner');
  });

  test('names the command that lists targets when the entity declares no foreign key at all', () => {
    const loners = entity('relation_map_loners', { columns: { id: uuid().primaryKey() } });
    const error = caught(() => relationNamed(loners.$name, 'anything'));
    expect(error).toBeUltimateError('X_PRELOAD_UNKNOWN_RELATION');
    expect(error?.fix).toContain('x entities list --json');
    expect(error?.fix).toContain('.references(() => <target>.id)');
  });
});
