import { describe, expect, test } from 'bun:test';
import {
  id,
  integer,
  locale,
  money,
  nullable,
  orgId,
  slug,
  table,
  text,
  timestamps,
  tz,
} from './columns';

describe('money', () => {
  const columns = money('price');

  test('rejects a float — 12.34 is not 1234 minor units', () => {
    expect(() => columns.priceMinor.parse(12.34)).toThrow(/money-minor-units|float/);
    expect(() => columns.priceMinor.parse(0.1)).toThrow(/float/);
    expect(() => columns.priceMinor.parse(Number.NaN)).toThrow();
  });

  test('the message tells an agent exactly what to send instead', () => {
    try {
      columns.priceMinor.parse(12.34);
      throw new Error('expected a throw');
    } catch (error) {
      expect(String(error)).toContain('1234n');
    }
  });

  test('accepts bigint, integer number and integer string', () => {
    expect(columns.priceMinor.parse(1234n)).toBe(1234n);
    expect(columns.priceMinor.parse(1234)).toBe(1234n);
    expect(columns.priceMinor.parse('-1234')).toBe(-1234n);
  });

  test('is bigint minor units plus an ISO-4217 code, never one column', () => {
    expect(columns.priceMinor.kind).toBe('bigint');
    expect(columns.priceCurrency.kind).toBe('char');
    expect(columns.priceCurrency.length).toBe(3);
    expect(columns.priceCurrency.parse('EUR')).toBe('EUR');
    expect(() => columns.priceCurrency.parse('eur')).toThrow(/iso-4217/);
    expect(() => columns.priceCurrency.parse('EURO')).toThrow(/iso-4217/);
  });

  test('emits a database CHECK so psql cannot write a bad currency either', () => {
    expect(columns.priceCurrency.check).toBe("price_currency ~ '^[A-Z]{3}$'");
  });
});

describe('time', () => {
  test('timestamps are always timestamptz — UTC storage is not optional', () => {
    const { createdAt, updatedAt } = timestamps();
    expect(createdAt.kind).toBe('timestamptz');
    expect(updatedAt.kind).toBe('timestamptz');
    expect(createdAt.name).toBe('created_at');
  });

  test('tz() accepts an IANA zone and rejects an abbreviation', () => {
    const column = tz();
    expect(column.parse('Europe/Berlin')).toBe('Europe/Berlin');
    expect(() => column.parse('CET+2')).toThrow(/iana-tz/);
    expect(() => column.parse('Mars/Olympus')).toThrow(/iana-tz/);
  });
});

describe('table()', () => {
  const posts = table('posts', {
    id: id(),
    title: text(),
    orgId: orgId(),
    publishedAt: nullable(text()),
    slug: slug(),
    views: integer(),
    lang: locale({ name: 'lang' }),
    ...timestamps(),
  });

  test('derives snake_case physical names from the property key', () => {
    expect(posts.columns.orgId.name).toBe('org_id');
    expect(posts.columns.publishedAt.name).toBe('published_at');
    expect(posts.columns.title.name).toBe('title');
  });

  test('collects the primary key and the indexes a migration needs', () => {
    expect(posts.primaryKey).toEqual(['id']);
    expect(posts.indexes.map((index) => index.name)).toContain('posts_slug_key');
    expect(posts.indexes.map((index) => index.name)).toContain('posts_org_id_idx');
    expect(posts.indexes.find((index) => index.name === 'posts_slug_key')?.unique).toBe(true);
  });

  test('nullable() widens the parser as well as the column', () => {
    expect(posts.columns.publishedAt.notNull).toBe(false);
    expect(posts.columns.publishedAt.parse(null)).toBeNull();
  });

  test('an orgId column carries its foreign key', () => {
    expect(posts.columns.orgId.references?.table).toBe('orgs');
    expect(posts.columns.orgId.references?.onDelete).toBe('cascade');
  });
});
