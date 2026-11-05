// A list's URL state, read and written as hrefs: what a server-rendered DataTable pages and sorts by
// with no island. Parsing never throws — every hostile parameter falls back to the default — and a
// cursor never survives a change to what it was minted for.

import { describe, expect, test } from 'bun:test';
import { listUrl } from './list-url';

const SORTS = ['title', 'createdAt'] as const;

describe('listUrl: reading', () => {
  test('a bare URL is the defaults', () => {
    const list = listUrl('/posts', { sorts: SORTS });
    expect(list.sort).toBeUndefined();
    expect(list.cursor).toBeUndefined();
    expect(list.limit).toBe(50);
    expect(list.q).toBeUndefined();
    expect(list.firstHref).toBeUndefined();
  });

  test('the parameters it names are read', () => {
    const list = listUrl('/posts?sort=title&dir=desc&after=c1&limit=20&q=%20hi%20', {
      sorts: SORTS,
    });
    expect(list.sort).toEqual({ key: 'title', direction: 'desc' });
    expect(list.cursor).toBe('c1');
    expect(list.limit).toBe(20);
    expect(list.q).toBe('hi');
  });

  test('hostile parameters are the default, never a throw', () => {
    const list = listUrl('/posts?sort=__proto__&dir=sideways&after=&limit=1e9&q=%20%20', {
      sorts: SORTS,
    });
    expect(list.sort).toBeUndefined();
    expect(list.cursor).toBeUndefined();
    expect(list.limit).toBe(50);
    expect(list.q).toBeUndefined();
    for (const limit of ['-3', '0', '2.5', 'abc', '101', '']) {
      expect(listUrl(`/posts?limit=${limit}`, { sorts: SORTS }).limit).toBe(50);
    }
    expect(listUrl('/posts?sort=title&dir=up', { sorts: SORTS }).sort).toEqual({
      key: 'title',
      direction: 'asc',
    });
  });

  test('the limit bounds are the caller’s', () => {
    const list = listUrl('/posts?limit=200', { sorts: SORTS, limit: { default: 25, max: 500 } });
    expect(list.limit).toBe(200);
    expect(listUrl('/posts', { sorts: SORTS, limit: { default: 25, max: 500 } }).limit).toBe(25);
  });

  test('a URL object reads the same as its string', () => {
    const list = listUrl(new URL('https://example.test/posts?sort=createdAt'), { sorts: SORTS });
    expect(list.sort).toEqual({ key: 'createdAt', direction: 'asc' });
    expect(list.href({})).toBe('/posts?sort=createdAt');
  });
});

describe('listUrl: writing', () => {
  const url = '/posts?tab=mine&sort=title&dir=desc&after=c1&q=hi';

  test('hrefFor sets the cursor and keeps everything else', () => {
    const list = listUrl(url, { sorts: SORTS });
    expect(list.hrefFor('c2', 'next')).toBe('/posts?tab=mine&sort=title&dir=desc&after=c2&q=hi');
  });

  test('any other change drops the cursor, keeping every foreign parameter', () => {
    const list = listUrl(url, { sorts: SORTS });
    expect(list.href({ q: 'there' })).toBe('/posts?tab=mine&sort=title&dir=desc&q=there');
    expect(list.href({ q: undefined })).toBe('/posts?tab=mine&sort=title&dir=desc');
    expect(list.href({ limit: 10 })).toBe('/posts?tab=mine&sort=title&dir=desc&q=hi&limit=10');
  });

  test('sortHrefFor writes the next sort state; undefined is unsorted', () => {
    const list = listUrl(url, { sorts: SORTS });
    expect(list.sortHrefFor({ key: 'createdAt', direction: 'asc' })).toBe(
      '/posts?tab=mine&sort=createdAt&dir=asc&q=hi',
    );
    expect(list.sortHrefFor(undefined)).toBe('/posts?tab=mine&q=hi');
  });

  test('firstHref is the list without its cursor, only once there is one', () => {
    expect(listUrl(url, { sorts: SORTS }).firstHref).toBe(
      '/posts?tab=mine&sort=title&dir=desc&q=hi',
    );
    expect(listUrl('/posts?q=hi', { sorts: SORTS }).firstHref).toBeUndefined();
  });

  test('a cursor is never written as text for an absent one', () => {
    const list = listUrl('/posts', { sorts: SORTS });
    expect(list.hrefFor('c1', 'next')).toBe('/posts?after=c1');
    expect(list.href({})).not.toContain('after');
  });
});

describe('listUrl: two lists on one page', () => {
  const url = '/ops?runs.after=r1&runs.sort=title&jobs.after=j1&jobs.q=x';

  test('ns prefixes every parameter, and each list reads only its own', () => {
    const runs = listUrl(url, { sorts: SORTS, ns: 'runs' });
    const jobs = listUrl(url, { sorts: SORTS, ns: 'jobs' });
    expect(runs.cursor).toBe('r1');
    expect(runs.sort).toEqual({ key: 'title', direction: 'asc' });
    expect(runs.q).toBeUndefined();
    expect(jobs.cursor).toBe('j1');
    expect(jobs.q).toBe('x');
  });

  test('paging one list keeps the other’s cursor', () => {
    const runs = listUrl(url, { sorts: SORTS, ns: 'runs' });
    expect(runs.hrefFor('r2', 'next')).toBe(
      '/ops?runs.after=r2&runs.sort=title&jobs.after=j1&jobs.q=x',
    );
  });

  test('any other change drops every cursor on the page — a cursor is bound to its filter', () => {
    const runs = listUrl(url, { sorts: SORTS, ns: 'runs' });
    expect(runs.href({ q: 'y' })).toBe('/ops?runs.sort=title&jobs.q=x&runs.q=y');
    expect(runs.firstHref).toBe('/ops?runs.sort=title&jobs.after=j1&jobs.q=x');
  });
});
