import { describe, expect, test } from 'bun:test';
import {
  assertInvariants,
  constraintName,
  invariant,
  invariantsToSql,
  toSql,
  unique,
} from './invariants';

interface Post {
  readonly id: string;
  readonly priceMinor: bigint;
  readonly slug: string;
  readonly orgId: string;
}

const pricePositive = invariant<Post>('price_positive', {
  message: 'price must be greater than zero',
  sql: 'price_minor > 0',
  columns: ['price_minor'],
  holds: (post) => post.priceMinor > 0n,
});

const slugPerOrg = unique<Post>('slug_per_org', {
  message: 'slug must be unique inside an org',
  columns: ['org_id', 'slug'],
  where: 'deleted_at is null',
});

describe('toSql', () => {
  test('a check invariant becomes an ALTER TABLE ... CHECK', () => {
    expect(toSql('posts', pricePositive)).toBe(
      'ALTER TABLE "posts" ADD CONSTRAINT "posts_price_positive_check" CHECK (price_minor > 0);',
    );
  });

  test('a unique invariant becomes a partial unique index', () => {
    expect(toSql('posts', slugPerOrg)).toBe(
      'CREATE UNIQUE INDEX "posts_slug_per_org_key" ON "posts" ("org_id", "slug") WHERE deleted_at is null;',
    );
  });

  test('constraint names are derived, not hand-written', () => {
    expect(constraintName('posts', pricePositive)).toBe('posts_price_positive_check');
    expect(constraintName('posts', slugPerOrg)).toBe('posts_slug_per_org_key');
  });

  test('a whole entity emits one statement per invariant', () => {
    expect(invariantsToSql('posts', [pricePositive, slugPerOrg]).split('\n')).toHaveLength(2);
  });
});

describe('assertInvariants', () => {
  const row: Post = { id: '1', priceMinor: 10n, slug: 'a', orgId: 'o1' };

  test('passes a valid row', () => {
    expect(() => assertInvariants('post', [pricePositive, slugPerOrg], row)).not.toThrow();
  });

  test('throws X_INVARIANT_VIOLATED naming the invariant and the rule', () => {
    expect(() => assertInvariants('post', [pricePositive], { ...row, priceMinor: 0n })).toThrow(
      /price_positive|greater than zero/,
    );
  });

  test('the app rule and the SQL rule describe the same predicate', () => {
    // If these two ever disagree the database silently becomes the only authority,
    // which is the exact failure this module exists to prevent.
    expect(pricePositive.holds({ ...row, priceMinor: 1n })).toBe(true);
    expect(pricePositive.holds({ ...row, priceMinor: 0n })).toBe(false);
    expect(pricePositive.sql).toContain('> 0');
  });
});
