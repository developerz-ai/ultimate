// What the shell actually emits: the landmarks, the skip link, the current-item marker, and both
// halves of the session control.
//
// The module is imported DYNAMICALLY on purpose. Bun loads a file's static imports before it
// executes any of them, so a static `import './app-shell'` would compile before
// `@ultimat3/render`'s module scope installed the `.tsx` loader — and every element would come out
// as `React.createElement` against a global that does not exist.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through. Without it every `t()` in the
// tree renders ⟦key⟧, which the last assertion here is what checks for.
import '@social-media-clone/i18n';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render/server';

const FILE = 'apps/web/shared/ui/app-shell.tsx';

let shell: typeof import('./app-shell');

const render = (url: string, signedIn: boolean): Promise<string> =>
  runWithContext(
    createContext({
      ...(signedIn ? { actor: userActor({ id: 'seeded-user', roles: ['member'] }) } : {}),
      tz: 'UTC',
      locale: 'en',
    }),
    () => renderComponent(shell.AppShell, { url }, FILE),
  );

beforeAll(async () => {
  shell = await import('./app-shell');
});

test('unit · the frame carries every landmark exactly once, plus the skip link', async () => {
  const html = await render('http://localhost/feed', false);

  expect(html).toContain('href="#main"');
  expect(html).toContain('id="main"');
  expect(html.match(/<main/g)?.length).toBe(1);
  expect(html.match(/<header/g)?.length).toBe(1);
  expect(html.match(/<footer/g)?.length).toBe(1);
  // Two navs by design: the header's primary nav and the footer's, each with its own name.
  expect(html).toContain('aria-label="Primary"');
  expect(html).toContain('aria-label="Footer"');
});

test('unit · the page you are on is marked, and only that one', async () => {
  const html = await render('http://localhost/feed', false);
  expect(html).toContain('href="/feed" aria-current="page"');
  expect(html.match(/aria-current="page"/g)?.length).toBe(1);
});

test('unit · signed out offers sign-in and none of the gated screens', async () => {
  const html = await render('http://localhost/', false);

  expect(html).toContain('href="/signin"');
  expect(html).toContain('href="/signup"');
  // A link whose only outcome is a 303 back to sign-in is not navigation.
  expect(html).not.toContain('href="/dashboard"');
  expect(html).not.toContain('href="/notifications"');
  expect(html).not.toContain('/api/sessions/destroy');
});

test('unit · signed in swaps the control and opens the four gated screens', async () => {
  const html = await render('http://localhost/dashboard', true);

  expect(html).toContain('href="/dashboard" aria-current="page"');
  expect(html).toContain('href="/friends"');
  expect(html).toContain('href="/messages"');
  expect(html).toContain('href="/notifications"');
  expect(html).toContain('action="/api/sessions/destroy"');
  expect(html).not.toContain('href="/signup"');
});

test('unit · every string in the frame comes from the catalog', async () => {
  // A missing key renders ⟦key⟧, which is visible on the page and passes every other assertion
  // here — so the absence of one is its own check.
  expect(await render('http://localhost/feed', false)).not.toContain('⟦');
  expect(await render('http://localhost/feed', true)).not.toContain('⟦');
});
