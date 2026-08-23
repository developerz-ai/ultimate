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
import { useI18n } from '@ultimat3/i18n';
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
  // `useI18n()`, not the bare `t`: `RouteMetaContext.t` is a `Translator` — the object with `has`,
  // `raw`, `keys` and `locale` on it — and that is what `metaContextFor` hands a real render.
  const meta = await page.config.meta({
    data: {},
    params: {},
    url: 'https://demo.test/',
    t: useI18n(),
  });
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
