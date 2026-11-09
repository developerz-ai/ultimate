import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

unitTest('one page per major, from the real wiki, at 0 KB', async () => {
  const majors = await page.config.prerender?.();
  expect(majors).toContain('30');
  const view = await renderRoute(page, {
    url: 'https://example.test/upgrading/30',
    params: { major: '30' },
  });
  expect(view.meta.title).toContain('→ 30.0.0');
  expect(view.islands).toEqual([]);
});

unitTest('a major the wiki does not carry is X_NOT_FOUND', async () => {
  await expect(
    renderRoute(page, { url: 'https://example.test/upgrading/1', params: { major: '1' } }),
  ).rejects.toMatchObject({ code: 'X_NOT_FOUND' });
});
