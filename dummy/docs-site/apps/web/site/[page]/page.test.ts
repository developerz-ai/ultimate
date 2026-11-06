// A manual page, rendered from the real wiki: prerendered for every page, 404 for no page, and
// its meta is the page's own title and lead.
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { docPage } from '../../shared/docs';
import * as page from './page';

unitTest('it prerenders every wiki page by its slug, and is 0 KB', async () => {
  const slugs = await page.config.prerender?.();
  expect(slugs).toContain('getting-started');
  expect(slugs).toContain('error-codes');
  expect(page.config.budget.js).toBe('0kb');
});

unitTest('a page renders under its title, with its lead as the description', async () => {
  const piece = await docPage('/getting-started');
  const view = await renderRoute(page, {
    url: 'https://example.test/getting-started',
    params: { page: 'getting-started' },
  });
  expect(view.meta.title).toBe(piece?.title);
  expect(view.meta.description).toBe(piece?.lead);
  expect(view.html.match(/<h1\b/g)).toHaveLength(1);
  expect(view.islands).toEqual([]);
});

unitTest('the split indexes mark their own destination', async () => {
  const view = await renderRoute(page, {
    url: 'https://example.test/upgrading',
    params: { page: 'upgrading' },
  });
  expect(view.html).toMatch(/href="\/upgrading"[^>]*aria-current="page"/);
});

unitTest('a slug no wiki page has is X_NOT_FOUND', async () => {
  await expect(
    renderRoute(page, { url: 'https://example.test/nowhere', params: { page: 'nowhere' } }),
  ).rejects.toMatchObject({ code: 'X_NOT_FOUND' });
});
