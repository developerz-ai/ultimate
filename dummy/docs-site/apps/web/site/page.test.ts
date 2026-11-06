// The front door, rendered: the five things it promises to say, under one h1, at zero JS.
import { useT } from '@docs-site/i18n';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

const url = 'https://example.test/';

unitTest('the front door says what, run, demo, why and when not, under one h1', async () => {
  const t = useT();
  const view = await renderRoute(page, { url });
  expect(view.html.match(/<h1\b/g)).toHaveLength(1);
  for (const key of [
    'site.home.headline',
    'site.home.runTitle',
    'site.home.demoTitle',
    'site.home.whyTitle',
    'site.home.whenNotTitle',
  ] as const) {
    expect(view.text).toContain(t(key));
  }
  for (const command of page.FIRST_COMMANDS) expect(view.text).toContain(command);
  expect(view.text).not.toContain('⟦');
});

unitTest('it links into the manual and out to the live demo', async () => {
  const view = await renderRoute(page, { url });
  const hrefs = [...view.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);
  expect(hrefs).toContain('/getting-started');
  expect(hrefs).toContain('/docs');
  expect(hrefs).toContain(page.DEMO_URL);
});

unitTest('it ships zero JS and declares its metadata', async () => {
  const t = useT();
  const view = await renderRoute(page, { url });
  expect(page.config.render).toBe('static');
  expect(page.config.budget.js).toBe('0kb');
  expect(view.islands).toEqual([]);
  expect(view.meta.title).toBe(t('site.home.title'));
  expect(view.meta.description).toBe(t('site.home.description'));
});
