// The offline fallback has to render with nothing: no network, no session, no database, and no
// JavaScript. Every one of those is a config field here, and every one of them rots the moment
// someone adds an import or a policy — at which point the page the service worker precaches is a
// page that cannot render when it is finally needed.
import { useT } from '@docs-site/i18n';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

const url = 'https://example.test/offline';

unitTest('the offline fallback renders with no actor, and says the network is gone', async () => {
  const t = useT();
  // No actor and no context: exactly what the service worker has when it serves this.
  const view = await renderRoute(page, { url });
  expect(view.html.match(/<h1\b/g)).toHaveLength(1);
  expect(view.text).toBe(`${t('app.offline.title')} ${t('app.offline.description')}`);
  expect(view.islands).toEqual([]);
});

unitTest('the offline fallback is static, precached, and ships no JavaScript', async () => {
  const view = await renderRoute(page, { url });
  expect(page.config.render).toBe('static');
  // 'precache', or the document that answers a lost network is itself fetched over the network.
  expect(page.config.offline).toBe('precache');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget.js).toBe('0kb');
  // A cached error page has nothing to index, and an indexed one outranks the page it stood in for
  // on the day the crawler happened to be offline.
  expect(view.meta.robots?.index).toBe(false);
});
