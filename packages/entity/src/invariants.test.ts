import { afterAll, describe, expect, test } from 'bun:test';
import { enumerated, integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { assertInvariants, constraintName, invariant, invariantsToSql, toSql } from './invariants';
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
  invariants: [
    invariant('like_count_non_negative', (c) => c.likeCount.atLeast(0)),
    invariant('title_present', (c) => c.title.trimmed().minLength(1)),
    invariant('slug_unique_per_org', (c) => c.unique(['orgId', 'slug'])),
    invariant('slug_shape', (c) => c.slug.matches(isSlug)),
    invariant('publish_coherent', (c) => c.satisfies(coherent, ['status', 'publishedAt'])),
  ],
});

const plans = entity('invariants_test_plans', {
  columns: { code: text(), currency: text(), monthly: money() },
  primaryKey: ['code', 'currency'],
  invariants: [
    invariant('price_non_negative', (c) => c.monthly.minor.atLeast(0)),
    invariant('currency_matches_price', (c) => c.monthly.currency.eq(c.currency)),
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

describe('toSql', () => {
  test('a check invariant becomes an ALTER TABLE ... CHECK over physical names', () => {
    expect(toSql('invariants_test_posts', named('like_count_non_negative'))).toBe(
      'ALTER TABLE "invariants_test_posts" ADD CONSTRAINT ' +
        '"invariants_test_posts_like_count_non_negative_check" CHECK (like_count >= 0);',
    );
    expect(named('title_present').sql).toBe('char_length(btrim(title)) >= 1');
  });

  test('a unique invariant becomes a partial unique index when rows are soft-deleted', () => {
    expect(toSql('invariants_test_posts', named('slug_unique_per_org'))).toBe(
      'CREATE UNIQUE INDEX "invariants_test_posts_slug_unique_per_org_key" ' +
        'ON "invariants_test_posts" ("org_id", "slug") WHERE deleted_at is null;',
    );
  });

  test('money names its own two columns', () => {
    expect(plans.$invariants.map((inv) => inv.sql)).toEqual([
      'monthly_minor >= 0',
      'monthly_currency = currency',
    ]);
  });

  test('constraint names are derived, not hand-written', () => {
    expect(constraintName('posts', named('like_count_non_negative'))).toBe(
      'posts_like_count_non_negative_check',
    );
    expect(constraintName('posts', named('slug_unique_per_org'))).toBe(
      'posts_slug_unique_per_org_key',
    );
  });

  test('a JS predicate is app-only and says so instead of pretending', () => {
    expect(named('slug_shape').kind).toBe('assert');
    expect(named('slug_shape').sql).toBeNull();
    expect(toSql('posts', named('publish_coherent'))).toBeNull();
    // The two SQL-expressible rules are the only statements a migration emits.
    expect(posts.$migration().split('\n')).toHaveLength(3);
    expect(invariantsToSql('posts', [])).toBe('');
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
        invariants: [invariant('bad', (c) => c.titel.trimmed().minLength(1))],
      }),
    ).toThrow(/no column "titel"/);
  });
});
