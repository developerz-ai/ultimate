// `x g query`: the declaration's two halves name ONE order, and its unit test stores rows when
// the slice still takes the row `x g entity` scaffolds. A query's `sql` builds the statement
// Postgres runs and its thunk is what the in-memory driver reads; ordered differently, a bounded
// read answers different rows by driver and every test on memory stays green.

import { describe, expect, test } from 'bun:test';
import { entityFiles } from './entity';
import { queryFiles } from './query';
import { resourceFiles } from './resource';

const target = { surfaceDir: 'apps/web/app', feature: 'invoice', dbModule: '@ledger/db' } as const;

const textAt = (files: readonly { path: string; contents: unknown }[], suffix: string): string => {
  const file = files.find((one) => one.path.endsWith(suffix));
  if (file === undefined) return expect.unreachable(`nothing emitted ends with ${suffix}`);
  return String(file.contents);
};

/** `.orderBy('createdAt', 'desc')` → `['createdAt', 'desc']`; an absent direction is `asc`. */
const ordersIn = (source: string): readonly (readonly [string, string])[] =>
  [...source.matchAll(/\.orderBy\('(\w+)'(?:, '(asc|desc)')?\)/g)].map(
    (match) => [match[1] ?? '', match[2] ?? 'asc'] as const,
  );

const SCAFFOLD_ENTITY = textAt(entityFiles('invoice', target), '/entity.ts');

describe('unit · x g query has one source of tenancy, the actor', () => {
  for (const live of [false, true]) {
    test(`${live ? 'live' : 'one-shot'}: no org in the input, the filter or the policy`, () => {
      const files = queryFiles('invoice-search', { ...target, live });
      const query = textAt(files, `/${live ? 'live' : 'queries'}/invoice-search.ts`);
      expect(query).toContain('input: t.object({ limit: t.number.default(50) }),');
      expect(query).not.toContain('.where({ orgId })');
      expect(query).not.toContain('orgId:');
      const policy = textAt(files, '/policy.ts');
      expect(policy).not.toMatch(/Read = can<[^>]*>\(/);
      expect(policy).toContain(
        "({ actor }) => actor !== null && typeof actor.orgId === 'string' && actor.orgId !== '',",
      );
    });
  }
});

describe('unit · x g query orders its SQL and its in-memory read the same way', () => {
  for (const live of [false, true]) {
    test(`${live ? 'live' : 'one-shot'}: the first sort key and its direction are the repo's own`, () => {
      const dir = live ? 'live' : 'queries';
      const query = textAt(
        queryFiles('invoice-search', { ...target, live }),
        `/${dir}/invoice-search.ts`,
      );
      const repo = textAt(entityFiles('invoice', target), '/repo.ts');
      // The thunk IS `repo.list`, so the order the SQL declares has to start where the repo's does.
      expect(query).toContain('() => repo.list(limit)');
      expect(ordersIn(repo)).toEqual([['createdAt', 'desc']]);
      expect(ordersIn(query)[0]).toEqual(['createdAt', 'desc']);
      // And it stays total: the primary key last, as the handle appends it to the repo's read.
      expect(ordersIn(query).at(-1)).toEqual(['id', 'asc']);
    });
  }

  test('the emitted test pins the direction in the SQL text, not only that an ORDER BY exists', () => {
    const spec = textAt(queryFiles('invoice-search', target), '/queries/invoice-search.test.ts');
    expect(spec).toContain(`expect(text).toContain('order by "createdat" desc');`);
  });
});

describe('unit · x g query stores rows when the slice still takes the scaffold row', () => {
  const STORED = 'stored rows read back newest first, bounded, and never another org';

  test('told the scaffold entity, the unit test reads back rows it stored — newest first', () => {
    const spec = textAt(
      queryFiles('invoice-search', { ...target, sliceEntity: SCAFFOLD_ENTITY }),
      '/queries/invoice-search.test.ts',
    );
    expect(spec).toContain(STORED);
    expect(spec).toContain("import { driver } from '@ledger/db';");
    expect(spec).toContain("import * as repo from '../repo';");
    expect(spec).toContain("expect(page.map((row) => row.title)).toEqual(['third', 'second']);");
  });

  test('a live query gets the same case in its UNIT file, never in the live suite', () => {
    const files = queryFiles('invoice-feed', {
      ...target,
      live: true,
      sliceEntity: SCAFFOLD_ENTITY,
    });
    expect(textAt(files, '/live/invoice-feed.test.ts')).toContain(STORED);
    expect(textAt(files, '/live/invoice-feed.live.test.ts')).not.toContain(STORED);
  });

  test('a live query’s LIVE suite subscribes for real, as two orgs', () => {
    const live = textAt(
      queryFiles('invoice-feed', { ...target, live: true, sliceEntity: SCAFFOLD_ENTITY }),
      '/live/invoice-feed.live.test.ts',
    );
    // Through the `subscribe` fixture — a sync node — over the module's own registered export.
    expect(live).toContain("const live = registerQuery('invoiceFeed', invoiceFeed);");
    // ONE input for both orgs: the window is the subscriber's tenant, never a parameter.
    expect(live).toContain('const ours = await subscribe<Row>(live, input, readerOf(orgId));');
    expect(live).toContain('subscribe<Row>(live, input, readerOf(otherOrg));');
    expect(live).not.toContain('orgId: org, limit');
    expect(live).toContain("expect(theirs.rows().map((row) => row.title)).toEqual(['theirs']);");
    // With no row it can spell, the live suite stays the declaration's and subscribes to nothing.
    const bare = textAt(queryFiles('invoice-feed', { ...target, live: true }), '.live.test.ts');
    expect(bare).not.toContain('subscribe');
  });

  test('an entity an author reshaped, or none at all, gets the cases that need no row', () => {
    const reshaped = SCAFFOLD_ENTITY.replace('    title: text(', '    headline: text(');
    expect(reshaped).not.toBe(SCAFFOLD_ENTITY);
    for (const sliceEntity of [reshaped, undefined]) {
      const spec = textAt(
        queryFiles('invoice-search', {
          ...target,
          ...(sliceEntity === undefined ? {} : { sliceEntity }),
        }),
        '/queries/invoice-search.test.ts',
      );
      expect(spec).not.toContain(STORED);
      expect(spec).not.toContain('../repo');
      expect(spec).toContain('an org with no rows reads empty');
    }
  });

  test('x g resource hands its own entity to its live query', () => {
    const files = resourceFiles('invoice', { surfaceDir: 'apps/web/app', feature: 'invoice' });
    expect(textAt(files, '/live/invoice-list.test.ts')).toContain(STORED);
  });
});
