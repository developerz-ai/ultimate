// The static half of the tenant proof: an entity with no tenant whose references reach one that
// has a tenant, and no `shared` reason, is `X_ENTITY_TENANT_UNDECLARED`. Built from real `entity()`
// declarations so the walk reads the description `describeEntities()` actually hands it.

import { afterAll, describe, expect, test } from 'bun:test';
import { type AnyColumn, clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { entityTenantFindings } from './exercise-static';

afterAll(() => clearRegistry());

const orgs = entity('xs_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 80 }) } });
// The spec's probe: tenant-columned parent, child keyed to it with no tenant column.
const docs = entity('xs_docs', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => orgs.id),
    title: text({ max: 80 }),
  },
});
const attachments = entity('xs_attachments', {
  columns: {
    id: uuid().primaryKey(),
    docId: uuid().references(() => docs.id),
    url: text({ max: 200 }),
  },
});
const thumbs = entity('xs_thumbs', {
  columns: { id: uuid().primaryKey(), attachmentId: uuid().references(() => attachments.id) },
});
const scopedNotes = entity('xs_scoped_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    docId: uuid().references(() => docs.id),
  },
});
const sharedLinks = entity('xs_shared_links', {
  shared: 'a public share link: readable by anyone holding it, by design',
  columns: { id: uuid().primaryKey(), docId: uuid().references(() => docs.id) },
});
const linkClicks = entity('xs_link_clicks', {
  columns: { id: uuid().primaryKey(), linkId: uuid().references(() => sharedLinks.id) },
});
const unrelated = entity('xs_unrelated', {
  columns: { id: uuid().primaryKey(), orgRef: uuid().references(() => orgs.id) },
});

const codesAt = (entities: readonly { $describe(): ReturnType<typeof docs.$describe> }[]) =>
  entityTenantFindings(entities.map((e) => e.$describe())).map((f) => [f.code, f.at]);

describe('unit · entityTenantFindings', () => {
  test('a child keyed to a tenant-columned parent, with no tenant, is a finding', () => {
    const [finding] = entityTenantFindings([docs.$describe(), attachments.$describe()]);
    expect(finding?.code).toBe('X_ENTITY_TENANT_UNDECLARED');
    expect(finding?.at).toBe('xs_attachments');
    expect(finding?.cause).toContain('xs_attachments -> xs_docs');
    // Both moves, runnable: the column then the migration, or the reason.
    expect(finding?.fix).toContain('orgId: uuid().tenant()');
    expect(finding?.fix).toContain("x db gen 'xs_attachments tenant'");
    expect(finding?.fix).toContain("shared: '<why it belongs to no tenant>'");
  });

  test('a grandchild reaching the tenant through an untenanted child is caught too', () => {
    expect(codesAt([docs, attachments, thumbs])).toEqual([
      ['X_ENTITY_TENANT_UNDECLARED', 'xs_attachments'],
      ['X_ENTITY_TENANT_UNDECLARED', 'xs_thumbs'],
    ]);
    const thumb = entityTenantFindings([docs, attachments, thumbs].map((e) => e.$describe()))[1];
    expect(thumb?.cause).toContain('xs_thumbs -> xs_attachments -> xs_docs');
  });

  test('a shared reason clears the entity', () => {
    expect(codesAt([docs, sharedLinks])).toEqual([]);
  });

  test('the walk stops at a shared entity: what hangs off a global row is not reached', () => {
    expect(codesAt([docs, sharedLinks, linkClicks])).toEqual([]);
  });

  test('a tenant-columned child is clean', () => {
    expect(codesAt([docs, scopedNotes])).toEqual([]);
  });

  test('a key to the tenant root itself reaches no tenant-columned entity', () => {
    // `orgs` carries no tenant column: it IS the tenant. A row keyed only to it reads nothing scoped.
    expect(codesAt([orgs, unrelated])).toEqual([]);
  });

  test('a reference cycle terminates, and a tenant beyond it is still found', () => {
    const loopA = entity('xs_loop_a', {
      columns: {
        id: uuid().primaryKey(),
        bId: uuid()
          .nullable()
          .references((): AnyColumn => loopB.id),
      },
    });
    const loopB = entity('xs_loop_b', {
      columns: {
        id: uuid().primaryKey(),
        aId: uuid()
          .nullable()
          .references((): AnyColumn => loopA.id),
        docId: uuid()
          .nullable()
          .references(() => docs.id),
      },
    });
    expect(codesAt([loopA, loopB])).toEqual([]);
    expect(codesAt([docs, loopA, loopB])).toEqual([
      ['X_ENTITY_TENANT_UNDECLARED', 'xs_loop_a'],
      ['X_ENTITY_TENANT_UNDECLARED', 'xs_loop_b'],
    ]);
  });
});
