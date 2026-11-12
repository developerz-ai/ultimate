// The sign-in page: a native form that needs no script, and — `createSession` declaring `native` —
// the refusal its `load` read rendered as a sentence above the fields, never the submitted values.
//
// The page module is imported DYNAMICALLY, for the reason `dashboard/page.test.ts` gives.

import { beforeAll, expect, test } from 'bun:test';
import '@social-media-clone/i18n';
import type { ActionAnswer } from '@ultimat3/action';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render/server';

const FILE = 'apps/web/site/signin/page.tsx';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

const render = (answer: ActionAnswer | null, query: Record<string, string> = {}) =>
  runWithContext(ctxOf({ tz: 'UTC', locale: 'en' }), () =>
    renderComponent(() => page.Page({ data: { answer }, query }), {}, FILE),
  );

test('unit · the page ships no script and is never served from a cache', () => {
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget?.js).toBe('0kb');
  expect(page.config.offline).toBe('network-only');
});

test('unit · a refused sign-in shows why, and keeps where the visitor was going', async () => {
  const html = await render(
    {
      action: 'createSession',
      outcome: 'refusal',
      code: 'X_AUTH_CREDENTIALS_INVALID',
      issues: [],
      truncated: false,
    },
    { next: '/messages' },
  );
  expect(html).toContain('That handle and password do not match.');
  expect(html).toContain('value="/messages"');
  expect(html).toContain('action="/api/sessions/create"');
  expect(html).not.toContain('⟦');
});

test('unit · a first visit shows the form and no refusal', async () => {
  const html = await render(null);
  expect(html).not.toContain('role="alert"');
  expect(html).toContain('value="/dashboard"');
});
