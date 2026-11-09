// `/search`: the form works as markup, the island is the page's one module, and the budget is
// the island's own.
import { useT } from '@docs-site/i18n';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

unitTest('the search page renders its form and one island', async () => {
  const t = useT();
  const view = await renderRoute(page, { url: 'https://example.test/search' });
  expect(view.meta.title).toBe(t('docs.search.title'));
  expect(view.html).toContain('<search>');
  expect(view.html).toContain('name="q"');
  expect(view.islands).toHaveLength(1);
  expect(view.text).not.toContain('⟦');
});
