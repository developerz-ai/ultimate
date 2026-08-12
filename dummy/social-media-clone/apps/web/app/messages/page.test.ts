// The conversation list, rendered. Same reason as the inbox's test: the seed creates no
// conversations, so the empty branch is the only branch this screen has ever taken — and it used to
// throw X_UI_RUNTIME_MISSING on it, behind a gate nobody could get past to see.
//
// The page module is imported DYNAMICALLY: Bun loads a file's static imports before executing any
// of them, so a static import would compile before `@ultimat3/render` installs the `.tsx` loader.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` here
// renders ⟦key⟧ — which the last assertion is what checks for.
import '@social-media-clone/i18n';
import { createContext, runWithContext } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render';

const FILE = 'apps/web/app/messages/page.tsx';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

test('unit · an anonymous render produces the empty state, not a thrown renderer', async () => {
  const html = await runWithContext(createContext({ tz: 'UTC', locale: 'en' }), () =>
    renderComponent(page.Page, { url: 'http://localhost/messages' }, FILE),
  );

  expect(html).toContain('No conversations yet.');
  expect(html).toContain('href="#main"');
  expect(html.match(/<main/g)?.length).toBe(1);
  expect(html).not.toContain('⟦');
});
