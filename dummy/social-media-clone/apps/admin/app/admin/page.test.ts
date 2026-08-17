// The other half of the view-only proof: what the page actually EMITS.
//
// `policy.test.ts` shows the decision refuses a write. This shows the same decision produces the
// screen — the rows an operator may read, and no control they may not press — through the
// framework's own server renderer, with the actor carried on core's request context exactly as the
// HTTP pipeline carries it (packages/http/src/pipeline.ts:424).
//
// The page module is imported DYNAMICALLY on purpose. Bun loads a file's static imports before it
// executes any of them, so a static `import './page'` would be compiled before `@ultimat3/render`'s
// module scope installed the `.tsx` loader — and every element would come out as
// `React.createElement` against a global that does not exist.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` in
// the tree renders `⟦key⟧`. The dev server gets this for free — the framework's module scan walks
// `packages/*/src/**` — but a test file reaches the page directly and has to say so.
import '@social-media-clone/i18n';
import { seedDemo } from '@social-media-clone/db';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render';
import { ADMIN_ACTION_ROUTE } from '../../shared/action-route';

const FILE = 'apps/admin/app/admin/page.tsx';

let page: typeof import('./page');

const render = (roles: readonly string[] | null): Promise<string> =>
  runWithContext(
    createContext({
      ...(roles === null ? {} : { actor: userActor({ id: 'seeded-admin', roles }) }),
      tz: 'UTC',
      locale: 'en',
    }),
    () => renderComponent(page.Page, { params: {}, url: 'http://localhost/admin' }, FILE),
  );

beforeAll(async () => {
  await seedDemo();
  page = await import('./page');
});

test('the route is gated and server-rendered — a spa shell would ship the decision to the browser', () => {
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy?.permission).toBe('admin:read');
  expect(page.config.offline).toBe('network-only');
  // 0kb: nothing on this page is interactive, so nothing is hydrated.
  expect(page.config.budget.js).toBe('0kb');
});

test('the read-only operator sees the seeded rows and no write control', async () => {
  const html = await render(['admin']);

  // Generated from the entities: a column the resource derived, and a row the seed wrote.
  expect(html).toContain('Storage key');
  expect(html).toContain('demo/ada/tenancy-cover.jpg');
  expect(html).toContain('Ada Okonjo');
  // Formatted with an explicit zone, never an ambient one. UTC here because that is the actor's.
  expect(html).toContain('Mar 2, 2026, 12:59 PM');

  // The matrix, rendered — the same decision, on screen.
  expect(html).toContain('admin:read + users:read');
  expect(html).toContain('admin:write + users:write');
  // No control they cannot press — and no FORM either. The label alone is a weak assertion: the
  // page shipped a `<button>` with no handler and no form for a release, which reads as a control
  // and acts as nothing.
  expect(html).not.toContain('Suspend user');
  expect(html).not.toContain(ADMIN_ACTION_ROUTE);
  expect(html).toContain('No action on this resource is available to you.');
});

test('an anonymous caller gets the refusal, not an empty table', async () => {
  const html = await render(null);

  expect(html).toContain('not signed in');
  expect(html).toContain('Refused.');
  // The rows never reach the document at all — a denial is the absence of data, not CSS.
  expect(html).not.toContain('demo/ada/tenancy-cover.jpg');
});

test('an operator who holds the write grant DOES get the control — same template, same decision', async () => {
  const html = await render(['operator']);
  expect(html).toContain('Suspend user');
  expect(html).toContain('demo/ada/tenancy-cover.jpg');
});

test('the control is a form submit at the action route, naming the action and the row', async () => {
  const html = await render(['operator']);

  // A `<form method="post">` and a `type="submit"`, because nothing here hydrates: a `type="button"`
  // on a page with `hydrate: 'never'` is markup that can never do anything, which is what this
  // toolbar was. The target is the constant `runAdminAction` derives, never a typed-in path.
  expect(html).toContain(`method="post" action="${ADMIN_ACTION_ROUTE}"`);
  expect(html).toContain('<button type="submit"');
  expect(html).toContain('name="name" value="user.suspend"');

  // The SUBJECT. A toolbar button carried no row id at all, so even a wired one could not have
  // named what it acted on — every form here posts the id of its own row.
  const [, first = ''] = /name="id" value="([^"]+)"/.exec(html) ?? [];
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
});
