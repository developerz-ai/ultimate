import { afterAll, describe, expect, test } from 'bun:test';
import { enumerated, integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { invariantColumns } from './expr';
import { assertInvariants, invariant } from './invariants';
import { clearRegistry } from './registry';

const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);

const coherent = (status: string, publishedAt: Date | null): boolean =>
  (status === 'published') === (publishedAt !== null);

const posts = entity('invariants_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    slug: text({ max: 80 }),
    title: text(),
    likeCount: integer().default(0),
    status: enumerated(['draft', 'published']).default('draft'),
    publishedAt: timestamp().nullable(),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [
    invariant('like_count_non_negative', c.likeCount.atLeast(0)),
    invariant('title_present', c.title.trimmed().minLength(1)),
    invariant('slug_unique_per_org', c.unique(['orgId', 'slug'])),
    invariant('slug_shape', c.slug.matches(isSlug)),
    invariant('publish_coherent', c.satisfies(coherent, ['status', 'publishedAt'])),
  ],
});

const plans = entity('invariants_test_plans', {
  columns: { code: text(), currency: text(), monthly: money() },
  primaryKey: ['code', 'currency'],
  invariants: (c) => [
    invariant('price_non_negative', c.monthly.minor.atLeast(0)),
    invariant('currency_matches_price', c.monthly.currency.eq(c.currency)),
  ],
});

const named = (name: string) => {
  const found = posts.$invariants.find((inv) => inv.name === name);
  if (found === undefined) throw new Error(`no invariant ${name}`);
  return found;
};

afterAll(() => {
  clearRegistry();
});

// What a rule BINDS to. The DDL it becomes is `@ultimat3/db`'s and is proven there
// (`generate-invariant.test.ts`); this package rendered a second copy under the entity name until
// 2026-08-25, and these tests asserted that copy rather than anything a migration ever applied.
describe('bindInvariant', () => {
  test('a check invariant carries its predicate over physical names', () => {
    expect(named('like_count_non_negative').sql).toBe('like_count >= 0');
    expect(named('like_count_non_negative').columns).toEqual(['like_count']);
    expect(named('title_present').sql).toBe('char_length(btrim(title)) >= 1');
  });

  test('a unique invariant names its columns, and is partial when rows are soft-deleted', () => {
    expect(named('slug_unique_per_org').kind).toBe('unique');
    expect(named('slug_unique_per_org').columns).toEqual(['org_id', 'slug']);
    expect(named('slug_unique_per_org').sql).toBe('org_id, slug');
    expect(named('slug_unique_per_org').where).toBe('deleted_at is null');
  });

  test('money names its own two columns', () => {
    expect(plans.$invariants.map((inv) => inv.sql)).toEqual([
      'monthly_minor >= 0',
      'monthly_currency = currency',
    ]);
  });

  test('a JS predicate is app-only and says so instead of pretending', () => {
    expect(named('slug_shape').kind).toBe('assert');
    expect(named('slug_shape').sql).toBeNull();
    expect(named('publish_coherent').kind).toBe('assert');
    expect(named('publish_coherent').sql).toBeNull();
    // The two SQL-expressible rules are the only ones a constraint can carry.
    expect(posts.$invariants.filter((inv) => inv.sql !== null)).toHaveLength(3);
  });
});

describe('the app runs the same rules', () => {
  const row = {
    id: '00000000-0000-7000-8000-000000000001',
    orgId: '00000000-0000-7000-8000-0000000000a1',
    slug: 'a-slug',
    title: 'Hello',
    likeCount: 1,
    status: 'draft' as const,
    publishedAt: null,
    deletedAt: null,
  };

  test('a valid row passes every invariant', () => {
    expect(() => posts.$assert(row)).not.toThrow();
  });

  test('throws X_INVARIANT_VIOLATED naming the invariant and the rule', () => {
    expect(() => posts.$assert({ ...row, likeCount: -1 })).toThrow(
      /like_count_non_negative|at least 0/,
    );
    expect(() => posts.$assert({ ...row, title: '   ' })).toThrow(/title_present|at least 1/);
    expect(() => posts.$assert({ ...row, slug: 'Not A Slug' })).toThrow(/slug_shape/);
    expect(() => posts.$assert({ ...row, status: 'published' })).toThrow(/publish_coherent/);
  });

  test('the app rule and the SQL rule describe the same predicate', () => {
    // If these two ever disagree the database silently becomes the only authority, which is
    // the exact failure this module exists to prevent.
    const rule = named('like_count_non_negative');
    expect(rule.holds({ ...row, likeCount: 0 })).toBe(true);
    expect(rule.holds({ ...row, likeCount: -1 })).toBe(false);
    expect(rule.sql).toContain('>= 0');
  });

  test('uniqueness is the database’s call, so the row check passes', () => {
    expect(named('slug_unique_per_org').holds(row)).toBe(true);
    expect(() => assertInvariants('posts', posts.$invariants, row)).not.toThrow();
  });

  test('a typo in a column name fails when the entity is declared', () => {
    expect(() =>
      entity('invariants_test_typo', {
        columns: { id: uuid().primaryKey(), title: text() },
        // A compile error first (`InvariantColumns<C>` is mapped over the declared columns, so
        // `titel` is not a key); the Proxy is what still catches a JS caller, and its message
        // names the columns that do exist.
        // @ts-expect-error `titel` is not a declared column — pinned in `type-pins.ts` too
        invariants: (c) => [invariant('bad', c.titel.trimmed().minLength(1))],
      }),
    ).toThrow(/no column "titel"/);
  });

  test('the physical name a rule binds comes from the entity, never from the author', () => {
    // `orgId` -> `org_id` and `monthly` -> `monthly_minor` happen exactly once, in `entity()`.
    expect(named('slug_unique_per_org').columns).toEqual(['org_id', 'slug']);
    expect(plans.$invariants.map((inv) => inv.columns)).toEqual([
      ['monthly_minor'],
      ['monthly_currency', 'currency'],
    ]);
  });

  test('a JS caller reaching the proxy untyped still gets the naming error', () => {
    // The compile error is unavailable to a plain-JS app and to a rule built dynamically, so the
    // Proxy stays: it names the columns that do exist instead of `undefined is not a function`.
    const columns = invariantColumns('invariants_test_js', ['title', 'slug']) as unknown as Record<
      string,
      unknown
    >;
    expect(() => columns['titel']).toThrow(/no column "titel"; declared columns are title, slug/);
    expect(columns['title']).toBeDefined();
  });
});
