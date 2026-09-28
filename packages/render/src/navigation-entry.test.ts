// `@ultimat3/render/navigation`: importing the entry IS starting the router, against the page's
// own `window` — the one thing this file does, and the reason it is a declared side effect.
import { expect, test } from 'bun:test';
import type { NavigationRouter } from './navigation';
import { FakeDocument, fakeWindow, routerHead } from './navigation-dom-fixture';

test('importing the entry starts the router on the window, once', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const win = fakeWindow(new FakeDocument(routerHead('A')), 'https://app.test/a', () =>
    Promise.reject(new TypeError('no network in this test')),
  );
  globals['window'] = win;
  try {
    await import('./navigation-entry');
    const router = win.__xNavigation as NavigationRouter | undefined;
    expect(router).toBeDefined();
    router?.stop();
    expect(win.__xNavigation).toBeUndefined();
  } finally {
    delete globals['window'];
  }
});
