// Link mode: a pager a server render can ship with no island. `hrefFor` turns each cursor into a
// URL, so "next" is an anchor the browser follows on its own — and the test asserts the ELEMENT,
// because a `<button>` with an `href`-shaped prop would read the same in a snapshot of labels.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { Pagination, type PaginationProps } from './Pagination';

const hrefFor = (cursor: string, direction: 'next' | 'prev'): string =>
  `/posts?${direction === 'next' ? 'after' : 'before'}=${cursor}`;

describe('Pagination with hrefFor', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the component compiles to a JSX factory this file understands', () => {
    expect(renderNodes(Pagination, { nextCursor: 'c', hrefFor }).length).toBeGreaterThan(0);
  });

  test('each cursor becomes an anchor at the URL hrefFor answers, previous first', () => {
    const nodes = renderNodes(Pagination, { prevCursor: 'p1', nextCursor: 'n1', hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual([
      '/posts?before=p1',
      '/posts?after=n1',
    ]);
    expect(byTag(nodes, 'button')).toEqual([]);
  });

  test('the anchors carry no handler — the browser does the navigating', () => {
    const nodes = renderNodes(Pagination, { prevCursor: 'p1', nextCursor: 'n1', hrefFor });
    for (const anchor of byTag(nodes, 'a')) expect(anchor.props['onClick']).toBeUndefined();
  });

  test('each anchor says which way it goes, for a crawler and a prefetcher', () => {
    const nodes = renderNodes(Pagination, { prevCursor: 'p1', nextCursor: 'n1', hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['rel'])).toEqual(['prev', 'next']);
  });

  // A link to nowhere is a dead control that still takes a tab stop. The absent side stays in
  // place — the pager does not jump between the first page and the second — as a disabled button.
  test('a side with no cursor is an inert button, never an anchor without a destination', () => {
    const nodes = renderNodes(Pagination, { nextCursor: 'n1', hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual(['/posts?after=n1']);
    const inert = one(byTag(nodes, 'button'), 'disabled side');
    expect(inert.props['disabled']).toBe(true);
    expect(inert.props['aria-disabled']).toBe('true');
  });

  test('the labels are the same ones callback mode shows', () => {
    const nodes = renderNodes(Pagination, {
      prevCursor: 'p1',
      nextCursor: 'n1',
      hrefFor,
      labelPrevious: 'Newer',
      labelNext: 'Older',
    });
    expect(byTag(nodes, 'span').map((node) => node.props['children'])).toEqual(['Newer', 'Older']);
  });

  test('a URL hrefFor answers goes through the same scheme check as any link', () => {
    const nodes = renderNodes(Pagination, { nextCursor: 'n1', hrefFor: () => 'javascript:x()' });
    expect(one(byTag(nodes, 'a'), 'next').props['href']).toBeUndefined();
  });

  /**
   * One mode per use, held by the type: each directive is red the day the union stops refusing
   * the pairing beneath it (`scripts/test-typecheck-gate.ts` compiles this file).
   */
  test('hrefFor beside a callback or a page number is not a PaginationProps', () => {
    const onCursor = (): void => {};
    // @ts-expect-error hrefFor and onCursor are two modes
    const both: PaginationProps = { nextCursor: 'n1', hrefFor, onCursor };
    // @ts-expect-error link mode pages by cursor; a numbered pager has no cursor to build a URL from
    const numbered: PaginationProps = { page: 2, totalPages: 5, hrefFor };
    const links: PaginationProps = { nextCursor: 'n1', hrefFor };
    const callbacks: PaginationProps = { nextCursor: 'n1', onCursor, hrefFor: undefined };
    expect([both, numbered, links, callbacks]).toHaveLength(4);
  });
});
