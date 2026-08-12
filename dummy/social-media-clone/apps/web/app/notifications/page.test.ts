// The inbox, rendered.
//
// This exists because the screen used to THROW on the path it takes every single time: it reached
// for `@ultimat3/ui`'s `EmptyState`, which calls `useUi()`, which needs a registered Solid runtime
// that a server render through the inert JSX factory does not have (X_UI_RUNTIME_MISSING). The seed
// creates no notifications, so the empty branch is the only branch — and the route is gated, so
// nobody could open it and find out.
//
// The page module is imported DYNAMICALLY: Bun loads a file's static imports before executing any
// of them, so a static import would compile before `@ultimat3/render` installs the `.tsx` loader.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` here
// renders ⟦key⟧ — which the last assertion is what checks for.
import '@social-media-clone/i18n';
import { createContext, runWithContext } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render';

const FILE = 'apps/web/app/notifications/page.tsx';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

test('unit · the empty inbox renders instead of throwing, and says why it is empty', async () => {
  const html = await runWithContext(createContext({ tz: 'UTC', locale: 'en' }), () =>
    renderComponent(page.Page, { url: 'http://localhost/notifications' }, FILE),
  );

  expect(html).toContain('Nothing has happened yet.');
  expect(html).toContain('0 unread');
  // Inside the app's own frame, not a bare `<main>` — one `<main>`, one skip link, one footer.
  expect(html).toContain('href="#main"');
  expect(html.match(/<main/g)?.length).toBe(1);
  expect(html).not.toContain('⟦');
});
