// The landing page: what it declares, and what it actually emits.
//
// The page module is imported DYNAMICALLY, for the reason `apps/admin/app/admin/page.test.ts`
// spells out: Bun loads a file's static imports before executing any of them, so a static
// `import './page'` compiles before `@ultimat3/render`'s module scope installs the `.tsx` loader,
// and every element comes out as `React.createElement` against a global that does not exist.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through. Without it every `t()` in the
// tree renders `⟦key⟧` — which is exactly what the last assertion here is checking for.
import '@social-media-clone/i18n';
import { metaContextFor } from '@ultimat3/render';
import { renderComponent } from '@ultimat3/render/server';

const FILE = 'apps/web/site/page.tsx';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

test('unit · the landing page ships zero JS and declares metadata', async () => {
  expect(page.config.render).toBe('static');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget.js).toBe('0kb');
  // `metaContextFor`, the builder every real render calls: the context carries the translator, the
  // locale and the page's locale alternates, and a hand-built literal restated all of them.
  const meta = await page.config.meta(
    metaContextFor({ params: {}, url: 'https://demo.test/' }, {}),
  );
  expect(meta.title ?? '').not.toBe('');
});

// This page shipped for weeks as the generator's placeholder — "Everything you need, one command
// from shippable" over a single link to `/dashboard`, which 401s a signed-out visitor. A title
// assertion alone passed the whole time, because the placeholder had a title too.
test('unit · it says what this deployment is, and links somewhere anonymous', async () => {
  const html = await renderComponent(
    page.HomePage,
    { data: {}, params: {}, url: '/', query: {} },
    FILE,
  );
  expect(html).toContain('href="/feed"');
  expect(html).toContain('href="/signin"');
  expect(html.toLowerCase()).toContain('seeded');
  // A missing catalog key renders ⟦key⟧, which is visible on the page and passes every other
  // assertion here — so the absence of one is its own check.
  expect(html).not.toContain('⟦');
});

// The hero's motion is stylesheet animation, so the page keeps its 0kb budget: `Aurora` in its CSS
// tier and the title through `TextReveal`, whose readable node carries the sentence once and whose
// animated twin is hidden from assistive technology.
test('unit · the hero is an Aurora with a revealed title, both at the CSS tier', async () => {
  const html = await renderComponent(
    page.HomePage,
    { data: {}, params: {}, url: '/', query: {} },
    FILE,
  );
  expect(html).toContain('data-effect-backend="css"');
  expect(html.match(/<h1\b[^>]*>.*?<\/h1>/s)?.[0]).toMatch(
    /data-effect-backend="css"[^>]*>.*aria-hidden="true"/s,
  );
});
