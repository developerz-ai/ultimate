// What the dashboard actually EMITS, with no page file in this app: `defineAdmin()` in `admin.ts`
// is the whole declaration, and every screen below is the framework's own, served under `/admin`.
//
// `policy.test.ts` shows the decision refuses a write. This shows the same decision produces the
// screen — the rows an operator may read, and no control they may not press — through the
// framework's own server renderer, with the actor carried on core's request context exactly as the
// HTTP pipeline carries it.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` in
// the tree renders `⟦key⟧`. The dev server gets this for free — the framework's module scan walks
// `packages/*/src/**` — but a test file reaches the admin directly and has to say so.
import '@social-media-clone/i18n';
import { seedDemo } from '@social-media-clone/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { memoryJobDriver, setJobDriver } from '@ultimat3/jobs';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `admin.ts` statically imports `pages/ops.tsx`. The rule is enforced by
// `apps/admin/static-tsx-imports.test.ts`, which explains the whole mechanism.
const { renderComponent } = await import('@ultimat3/render/server');
const { adminRouteMatch } = await import('@ultimat3/admin');
const { admin } = await import('./admin');

interface Answer {
  readonly status: number | string;
  readonly html: string;
}

const ask = (
  roles: readonly string[] | null,
  path: string,
  context: {
    readonly locale?: string;
    readonly tz?: string;
    readonly form?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<Answer> =>
  runWithContext(
    ctxOf({
      ...(roles === null ? {} : { actor: userActor({ id: 'seeded-admin', roles }) }),
      tz: context.tz ?? 'UTC',
      locale: context.locale ?? 'en',
    }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`the admin declares no route for ${path}`);
      const response = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: context.form === undefined ? 'GET' : 'POST',
        form: context.form ?? null,
      });
      if (response.kind === 'redirect') return { status: response.location, html: '' };
      return {
        status: response.status,
        html: await renderComponent(() => response.body, {}, 'apps/admin/app/admin/admin.ts'),
      };
    },
  );

beforeAll(async () => {
  // `/admin/jobs` reads the process's queue, as it does under `x dev` and in the container.
  setJobDriver(memoryJobDriver());
  await seedDemo();
});

test('this app serves the dashboard with NO page file — the declaration is the whole host', async () => {
  const pages: string[] = [];
  for await (const file of new Bun.Glob('**/page.tsx').scan({ cwd: import.meta.dir })) {
    pages.push(file);
  }
  // A page file here would be a second server for a URL the admin already serves.
  expect(pages).toEqual([]);
  expect(admin.routes.map((route) => route.path)).toContain('/admin/users/:id/edit');
});

test('the read-only operator sees the seeded rows and no write control', async () => {
  const users = await ask(['admin'], '/admin/users');
  expect(users.status).toBe(200);
  // Generated from the entity: a row the seed wrote, under the columns `listFields` names.
  expect(users.html).toContain('Ada Okonjo');
  // No control they cannot press — and no FORM either. The label alone is a weak assertion: the
  // page shipped a `<button>` with no handler and no form for a release, which reads as a control
  // and acts as nothing.
  expect(users.html).not.toContain('Suspend user');
  expect(users.html).not.toContain('method="post"');
  // The sensitive column is out of the list — its label and every address.
  expect(users.html).not.toContain('@demo.example');

  const media = await ask(['admin'], '/admin/media');
  expect(media.html).toContain('Storage key');
  expect(media.html).toContain('demo/ada/tenancy-cover.jpg');
});

test('the dashboard renders the decision: which permission pair, and which verdict', async () => {
  const home = await ask(['admin'], '/admin');
  expect(home.status).toBe(200);
  expect(home.html).toContain('admin:read + users:read');
  expect(home.html).toContain('admin:write + users:write');
  expect(home.html).toContain('denied —');
});

test('a timestamp is formatted in the ACTOR’s locale and zone — there is no ambient default', async () => {
  const stamp = (html: string): string => /<time[^>]*>([^<]+)<\/time>/.exec(html)?.[1] ?? '';
  const british = stamp((await ask(['admin'], '/admin/users', { locale: 'en-GB' })).html);
  const american = stamp((await ask(['admin'], '/admin/users', { locale: 'en-US' })).html);
  const tokyo = stamp(
    (await ask(['admin'], '/admin/users', { locale: 'en-US', tz: 'Asia/Tokyo' })).html,
  );
  expect(american).not.toBe('');
  // Same instant, same zone, two locales: identical output means the locale argument is ignored.
  expect(british).not.toBe(american);
  expect(tokyo).not.toBe(american);
});

test('an anonymous caller gets the refusal, not an empty table', async () => {
  const refused = await ask(null, '/admin/users');
  expect(refused.status).toBe(403);
  expect(refused.html).toContain('not signed in');
  expect(refused.html).toContain('Refused.');
  // The rows never reach the document at all — a denial is the absence of data, not CSS.
  expect(refused.html).not.toContain('Ada Okonjo');
});

test('an operator who holds the write grant DOES get the control — same screen, same decision', async () => {
  const html = (await ask(['operator'], '/admin/users')).html;
  expect(html).toContain('Suspend user');
  // A `<form method="post">` and a `type="submit"`, because nothing here hydrates. The target is
  // the ROW's own URL — the subject is never a hidden field a stale page could have got wrong.
  // The ROW's form, not the batch bar's (`id="x-admin-batch"`, posted at the list).
  const [, target = ''] = /<form class="[^"]*" method="post" action="([^"]+)"/.exec(html) ?? [];
  expect(target).toMatch(/^\/admin\/users\/[0-9a-f-]{36}$/);
  expect(html).toContain('name="name" value="user.suspend"');
  expect(html).toContain('type="submit"');
});

test('the ops board and the jobs screen are served by the same mount, behind their own pair', async () => {
  expect((await ask(['admin'], '/admin/ops')).status).toBe(200);
  expect((await ask(['admin'], '/admin/jobs')).status).toBe(200);
  expect((await ask(null, '/admin/ops')).status).toBe(403);
  // Reachable from the sidebar: a page nobody can find is a page that does not exist.
  const html = (await ask(['admin'], '/admin')).html;
  expect(html).toContain('href="/admin/ops"');
  expect(html).toContain('href="/admin/jobs"');
});

test('the suspend form, posted: refused for the read-only operator, run for one who holds the grant', async () => {
  const mara = seedId('user:mara');
  const form = { _operation: 'action', name: 'user.suspend' };
  const suspended = async (): Promise<unknown> =>
    (await admin.resource('users').repo?.find(mara))?.suspended;

  // Half one: the POST, made anyway by an actor whose page drew no button — refused by the same
  // decision, with the row untouched.
  const refused = await ask(['admin'], `/admin/users/${mara}`, { form });
  expect(refused.status).toBe(403);
  expect(refused.html).toContain('admin:write');
  expect(await suspended()).toBe(false);

  // Half two: the same POST from an operator runs the handler and lands back on the row.
  const ran = await ask(['operator'], `/admin/users/${mara}`, { form });
  expect(ran.status).toBe(`/admin/users/${mara}`);
  expect(await suspended()).toBe(true);

  // Half three: suspended now, so `when` hides the button on her row — and the server asks the
  // same rule again, so the forged second POST is X_ADMIN_ACTION_NOT_APPLICABLE, not a re-run.
  // (Her audit trail still NAMES the action — that is history, not a control.)
  expect((await ask(['operator'], `/admin/users/${mara}`)).html).not.toContain(
    'value="user.suspend"',
  );
  const again = await ask(['operator'], `/admin/users/${mara}`, { form });
  expect(again.status).toBe(409);
  expect(again.html).toContain('X_ADMIN_ACTION_NOT_APPLICABLE');
  // Put back, so the seed is what every other file in this suite reads.
  await admin.resource('users').repo?.update(mara, { suspended: false });
});

test('a user’s page: named sections, the default one for the rest, and their posts and uploads', async () => {
  const ada = seedId('user:ada');
  const page = await ask(['admin'], `/admin/users/${ada}`);
  expect(page.status).toBe(200);
  // The posts card is the POSTS list — its columns — filtered to Ada; Mara's are not on it.
  expect(page.html).toContain('<h2>Posts</h2>');
  expect(page.html).toContain('Visibility here is relational');
  expect(page.html).not.toContain('Written by someone who blocked the demo user');
  expect(page.html).toContain('Uploads');
  expect(page.html).toContain('demo/ada/tenancy-cover.jpg');
  // Bio is in no declared section: it is in the default one, never hidden.
  expect(page.html).toContain('Bio');
});

test('the batch bar: suspend over the checked users, counted honestly, each row on the audit log', async () => {
  const users = await ask(['operator'], '/admin/users');
  expect(users.html).toContain('form="x-admin-batch"');
  const [ada, bruno] = [seedId('user:ada'), seedId('user:bruno')];
  const repo = admin.resource('users').repo;
  await repo?.update(bruno, { suspended: true });
  const ran = await ask(['operator'], '/admin/users', {
    form: { _operation: 'batch', name: 'user.suspend', selection: 'checked', ids: [ada, bruno] },
  });
  expect(ran.status).toBe(200);
  // Ada was suspended; Bruno already was, so the action does not apply to him.
  expect((await repo?.find(ada))?.suspended).toBe(true);
  const entries = await admin.audit.entries({ entity: 'users', limit: 10 });
  expect(
    entries
      .filter((entry) => entry.operation === 'user.suspend')
      .slice(0, 2)
      .map((entry) => [entry.entityId, entry.outcome])
      .reverse(),
  ).toEqual([
    [ada, 'allowed'],
    [bruno, 'denied'],
  ]);
  await repo?.update(ada, { suspended: false });
  await repo?.update(bruno, { suspended: false });
});
