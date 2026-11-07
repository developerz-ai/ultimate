// `/errors/X_DB_DRIFT`: the row's cause on the page, the code as the title, 0 KB.
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { codePage } from '../../../shared/docs';
import * as page from './page';

unitTest('every code is prerendered; a page carries its row cells and its section', async () => {
  const codes = await page.config.prerender?.();
  expect(codes).toContain('X_DB_DRIFT');
  const view = await renderRoute(page, {
    url: 'https://example.test/errors/X_DB_DRIFT',
    params: { code: 'X_DB_DRIFT' },
  });
  expect(view.meta.title).toBe('X_DB_DRIFT');
  expect(view.meta.description?.startsWith('X_DB_DRIFT: ')).toBe(true);
  expect(view.text).toContain('Typical cause');
  expect(view.text).toContain('schema differs from migrations');
  expect(view.html).toContain('href="/error-codes#entity-and-database"');
  expect(view.islands).toEqual([]);
});

unitTest('a code two sections describe shows both rows', async () => {
  const both = await codePage('X_NOT_IMPLEMENTED');
  expect(both?.rows.length).toBeGreaterThan(1);
  const view = await renderRoute(page, {
    url: 'https://example.test/errors/X_NOT_IMPLEMENTED',
    params: { code: 'X_NOT_IMPLEMENTED' },
  });
  expect(view.html.match(/<section\b/g)?.length).toBe(both?.rows.length);
});

unitTest('a code with no page is X_NOT_FOUND', async () => {
  await expect(
    renderRoute(page, { url: 'https://example.test/errors/X_NOPE', params: { code: 'X_NOPE' } }),
  ).rejects.toMatchObject({ code: 'X_NOT_FOUND' });
});
