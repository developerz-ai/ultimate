// Link mode: a pager a server render can ship with no island. `hrefFor` turns each cursor into a
// URL, so "next" is an anchor the browser follows on its own — and the test asserts the ELEMENT,
// because a `<button>` with an `href`-shaped prop would read the same in a snapshot of labels.

import { describe, expect, test } from 'bun:test';
import { type Page, pageOf } from '@ultimat3/core';
import { byTag, one, renderNodes } from '@ultimat3/core/render-nodes';
import { Pagination, type PaginationProps } from './Pagination';

const hrefFor = (cursor: string, direction: 'next' | 'prev'): string =>
  `/posts?${direction === 'next' ? 'after' : 'before'}=${cursor}`;

describe('Pagination with hrefFor', () => {
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
    const nodes = renderNodes(Pagination, { prevCursor: 'p1', nextCursor: undefined, hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual(['/posts?before=p1']);
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

/**
 * The framework's own page, handed straight through. `Page.nextCursor` is `string | null`, and the
 * pager used to take `string | undefined`: the line the wiki shows did not compile, and cast past
 * it the last page linked to `?after=null`. `null` and `undefined` are one state — no next page.
 */
describe('Pagination over a Page', () => {
  const last: Page<{ id: string }> = pageOf([{ id: 'a' }], null);
  const more: Page<{ id: string }> = pageOf([{ id: 'a' }], 'n1');

  test('a Page assigns to the props as it is — the type pin', () => {
    const pinned: PaginationProps = { nextCursor: last.nextCursor, hrefFor };
    const callbacks: PaginationProps = { nextCursor: more.nextCursor, prevCursor: null };
    expect([pinned, callbacks]).toHaveLength(2);
  });

  test('the last page has no next anchor and never an `after=null`', () => {
    const nodes = renderNodes(Pagination, { nextCursor: last.nextCursor, hrefFor });
    expect(byTag(nodes, 'a')).toEqual([]);
    const hrefs = nodes.map((node) => node.props['href']).filter((href) => href !== undefined);
    expect(hrefs).toEqual([]);
    const inert = one(byTag(nodes, 'button'), 'next, disabled');
    expect(inert.props['disabled']).toBe(true);
  });

  test('a page with more links to it', () => {
    const nodes = renderNodes(Pagination, { nextCursor: more.nextCursor, hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual(['/posts?after=n1']);
  });
});

/**
 * Keyset paging has no way back: a framework `Page` carries no previous cursor, so a Previous
 * drawn for it is disabled forever. It is drawn only when a `prevCursor` is given or the pager is
 * numbered; the way back is `firstHref` / `onFirst`.
 */
describe('Pagination: Previous and First', () => {
  test('cursor mode with no prevCursor draws no Previous at all', () => {
    const nodes = renderNodes(Pagination, { nextCursor: 'n1', hrefFor });
    expect(byTag(nodes, 'button')).toEqual([]);
    expect(byTag(nodes, 'a').map((node) => node.props['rel'])).toEqual(['next']);
  });

  test('callback cursor mode with no prevCursor draws Next alone', () => {
    const nodes = renderNodes(Pagination, { nextCursor: 'n1', onCursor: () => {} });
    expect(byTag(nodes, 'button')).toHaveLength(1);
  });

  test('numbered mode keeps its Previous, disabled on page 1', () => {
    const nodes = renderNodes(Pagination, { page: 1, totalPages: 3, onPage: () => {} });
    const [previous, next] = byTag(nodes, 'button');
    expect(previous?.props['disabled']).toBe(true);
    expect(next?.props['disabled']).not.toBe(true);
  });

  test('firstHref is an anchor to the first page, ahead of the rest', () => {
    const nodes = renderNodes(Pagination, {
      nextCursor: 'n1',
      hrefFor,
      firstHref: '/posts',
      labelFirst: 'Start',
      labelNext: 'Older',
    });
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual([
      '/posts',
      '/posts?after=n1',
    ]);
    expect(byTag(nodes, 'span').map((node) => node.props['children'])).toEqual(['Start', 'Older']);
    // `rel` is a pager's next/prev only; the first page is no relation `Link` declares.
    expect(byTag(nodes, 'a').map((node) => node.props['rel'])).toEqual([undefined, 'next']);
  });

  test('onFirst is a button that calls it', () => {
    let called = 0;
    const nodes = renderNodes(Pagination, {
      nextCursor: 'n1',
      onCursor: () => {},
      onFirst: () => {
        called += 1;
      },
      labelFirst: 'Newest',
    });
    const first = byTag(nodes, 'button')[0];
    const click = first?.props['onClick'];
    if (typeof click !== 'function') expect.unreachable('onFirst renders no clickable button');
    click();
    expect(called).toBe(1);
    expect(byTag(nodes, 'span').map((node) => node.props['children'])).toContain('Newest');
  });

  test('firstHref beside a callback is not a PaginationProps', () => {
    // @ts-expect-error firstHref is link mode; a callback pager goes back with onFirst
    const mixed: PaginationProps = { nextCursor: 'n1', onCursor: () => {}, firstHref: '/p' };
    // @ts-expect-error onFirst is callback mode; a link pager goes back with firstHref
    const mixedLink: PaginationProps = { nextCursor: 'n1', hrefFor, onFirst: () => {} };
    expect([mixed, mixedLink]).toHaveLength(2);
  });
});
