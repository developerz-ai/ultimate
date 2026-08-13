/**
 * Pins the `entity` DSL surface. `entity.test.ts` proves the primitive behaves
 * correctly; this file proves the *shape* cannot silently drift — every
 * `$`-prefixed member still exists — and that each projection method is a thin
 * binding to its own module, never a second implementation. A member renamed,
 * dropped, or quietly reimplemented here fails this test, not just a
 * downstream consumer.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { text, timestamp, uuid } from './columns';
import { describeEntity } from './describe';
import { entity } from './entity';
import { assertInvariants, invariant, invariantsToSql } from './invariants';
import { clearRegistry } from './registry';
import { viewFor } from './view';

// The exact contract: `EntityCore<Row, C>` (entity.ts) — every framework member is
// `$`-prefixed by design (see the package CLAUDE.md), so it can never collide with
// a column name. Kept in sync by hand on purpose — a silent drift here is exactly
// the regression this file exists to catch.
const CORE_MEMBERS = [
  '$name',
  '$table',
  '$columns',
  '$primaryKey',
  '$indexes',
  '$invariants',
  '$tags',
  '$cacheTag',
  '$softDelete',
  '$tenantColumn',
  '$row',
  '$schema',
  '$tagFor',
  '$parse',
  '$view',
  '$assert',
  '$migration',
  '$describe',
  '$references',
] as const;

// Built once, like `entity.test.ts` does: `entity()` registers by name, so calling it
// again per test would collide with itself.
const target = entity('dsl_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('title_present', c.title.trimmed().minLength(1))],
});

afterAll(() => {
  clearRegistry();
});

describe('the entity DSL surface', () => {
  test('a built entity carries every $-prefixed core member', () => {
    // `in`, not `toHaveProperty`: `$row` is a getter that throws by design (it is a
    // phantom, never a value), and `toHaveProperty` reads the property to check it.
    for (const member of CORE_MEMBERS) expect(member in target).toBe(true);
  });

  test('the columns land on the entity too, alongside the $-prefixed members', () => {
    expect(target.id.$meta.kind).toBe('uuid');
    expect(target.title.$meta.kind).toBe('text');
  });

  test('$describe() delegates to describeEntity() with this entity own fields', () => {
    const direct = describeEntity({
      name: target.$name,
      columns: Object.entries(target.$columns),
      primaryKey: target.$primaryKey,
      invariants: target.$invariants,
      indexes: target.$indexes,
      tags: target.$tags,
      cacheTag: target.$cacheTag,
      softDelete: target.$softDelete,
      tenantColumn: target.$tenantColumn,
    });
    expect(target.$describe()).toEqual(direct);
  });

  test('$migration() delegates to invariantsToSql() over the entity own invariants', () => {
    expect(target.$migration()).toBe(invariantsToSql(target.$name, target.$invariants));
  });

  test('$assert() delegates to assertInvariants() — identical failure, not a reimplementation', () => {
    const row = { id: 'x', title: 'ok', createdAt: new Date() };
    expect(() => target.$assert(row)).not.toThrow();

    const bad = { ...row, title: '  ' };
    let facadeMessage: string | null = null;
    let directMessage: string | null = null;
    try {
      target.$assert(bad);
    } catch (error) {
      facadeMessage = error instanceof Error ? error.message : String(error);
    }
    try {
      assertInvariants(target.$name, target.$invariants, bad);
    } catch (error) {
      directMessage = error instanceof Error ? error.message : String(error);
    }
    expect(facadeMessage).not.toBeNull();
    expect(facadeMessage).toBe(directMessage);
  });

  test('$view() delegates to viewFor() — same keys, same projected shape', () => {
    const direct = viewFor(target.$name, target.$columns, ['id', 'title'] as const);
    const viaFacade = target.$view(['id', 'title'] as const);
    expect(viaFacade.$name).toBe(direct.$name);
    expect(viaFacade.$keys).toEqual(direct.$keys);
  });

  test('$row and view.$row are phantoms: reading either throws', () => {
    const loose = target as unknown as Record<string, unknown>;
    expect(() => loose['$row']).toThrow(/\$row is a type/);
    const view = target.$view(['id'] as const) as unknown as Record<string, unknown>;
    expect(() => view['$row']).toThrow(/\$row is a type/);
  });
});
