// `x verify`'s advice about the query an `isr` route keys on: a route that declared none (it keys
// on the whole query string), and a route whose declaration OMITS a parameter its own module reads
// — every visitor is then answered the document rendered for whichever value arrived first.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory or a recursive delete.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { isrQueryAdvice, queryReads } from './isr-query-advice';

let root = '';

const page = async (
  file: string,
  render: 'isr' | 'ssr',
  query?: readonly string[],
  source = 'export function Page() { return null; }\n',
): Promise<void> => {
  if (root === '') root = mkdtempSync(join(tmpdir(), 'x-isr-advice-'));
  await Bun.write(join(root, file), source);
  registerRoute({
    file,
    component: () => 'page',
    config: defineRoute({
      render,
      ...(render === 'isr'
        ? { revalidate: query === undefined ? { ttl: '5m' } : { ttl: '5m', query } }
        : {}),
      hydrate: 'never',
      offline: 'network-only',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Page', description: 'a page' }),
    }),
  });
};

afterEach(() => {
  clearRoutes();
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const PRICING = `export const config = defineRoute({
  render: 'isr',
  revalidate: { ttl: '5m', query: [] },
  // a comment that mentions query.ignored is not a read
  load: ({ url }) => ({ plan: new URL(url).searchParams.get('plan') }),
  meta: ({ url }) => ({ title: new URL(url).searchParams.has("ref") ? 'r' : 'p', description: 'd' }),
});
export function Page(props: { readonly query: { currency?: string } }) {
  const tab = props.query?.tab ?? props.query['view'];
  return props.query.currency ?? tab;
}
`;

describe('unit · isr query advice', () => {
  test('names each isr route with no revalidate.query, and no other route', async () => {
    await page('apps/web/site/blog/page.tsx', 'isr');
    await page('apps/web/site/pricing/page.tsx', 'isr', []);
    await page('apps/web/site/search/page.tsx', 'isr', ['q']);
    await page('apps/web/site/about/page.tsx', 'ssr');
    const advice = await isrQueryAdvice(root);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toStartWith('apps/web/site/blog/page.tsx: ');
    expect(advice[0]).toContain('revalidate: { query: [] }');
  });

  test('a declared query that omits a parameter the module reads is named, once per parameter', async () => {
    await page('apps/web/site/pricing/page.tsx', 'isr', ['currency'], PRICING);
    const advice = await isrQueryAdvice(root);
    expect(advice.map((line) => /reads the query parameter "(\w+)"/.exec(line)?.[1])).toEqual([
      'plan',
      'ref',
      'tab',
      'view',
    ]);
    expect(advice[0]).toStartWith('apps/web/site/pricing/page.tsx: ');
    expect(advice[0]).toContain("query: ['currency', 'plan']");
  });

  test('a route that declares everything it reads, or is not isr, gets no advice', async () => {
    await page(
      'apps/web/site/pricing/page.tsx',
      'isr',
      ['currency', 'plan', 'ref', 'tab', 'view'],
      PRICING,
    );
    await page('apps/web/site/quote/page.tsx', 'ssr', undefined, PRICING);
    expect(await isrQueryAdvice(root)).toEqual([]);
  });

  test('queryReads sees member, optional, bracket and searchParams reads — and no comment, call or declaration', () => {
    expect(
      queryReads(`// query.commented
        const a = query.one; const b = props.query?.two; const c = query['three'];
        url.searchParams.get('four'); searchParams.getAll("five");
        const builder = query.where({}); revalidate: { query: ['six'] }; queries.seven({});`),
    ).toEqual(['five', 'four', 'one', 'three', 'two']);
  });
});
