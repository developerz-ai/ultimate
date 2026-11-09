// The frame every docs page wears: four destinations, the current one marked, the page in <main>,
// and the footer the wiki's `[footer](_Footer)` links land on.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import { DocsShell } from './docs-shell';

unitTest('it marks the current destination and keeps the page in <main>', async () => {
  const view = await renderView(DocsShell, { nav: 'errors', children: 'the page body' });
  expect(view.html).toMatch(/href="\/error-codes"[^>]*aria-current="page"/);
  expect(view.html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(view.html).toMatch(/<main[^>]*>the page body<\/main>/);
  expect(view.html).toMatch(/<footer id="footer"/);
  expect(view.text).not.toContain('⟦');
});

unitTest('no nav marks nothing current', async () => {
  const view = await renderView(DocsShell, { children: 'body' });
  expect(view.html).not.toContain('aria-current="page"');
});
