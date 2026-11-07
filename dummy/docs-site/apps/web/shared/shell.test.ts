// The frame, rendered the way a route renders it, with the app's own catalog registered by the
// import. What can go wrong is structural — the current page losing its `aria-current`, the
// page's actions landing outside the banner — and both are invisible to a typecheck.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import { Shell } from './shell';

unitTest('the shell marks the current destination and keeps the page in <main>', async () => {
  const view = await renderView(Shell, { nav: 'dashboard', children: 'the page body' });
  expect(view.html).toMatch(/<a href="\/dashboard" aria-current="page"/);
  // Landmarks come from AppShell: one banner, one navigation, one main, one contentinfo.
  expect(view.html.match(/<main\b/g)).toHaveLength(1);
  expect(view.html.match(/<nav\b/g)).toHaveLength(1);
  expect(view.html).toMatch(/<main[^>]*>the page body<\/main>/);
});

unitTest('no nav marks nothing current, and the actions land in the header', async () => {
  const view = await renderView(Shell, { actions: 'the page actions', children: 'body' });
  expect(view.html).not.toContain('aria-current="page"');
  expect(view.html).toMatch(/<header[^>]*>[\s\S]*the page actions[\s\S]*<\/header>/);
});
