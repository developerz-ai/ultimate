// The admin walk, proved against a fake app that answers the way a scaffolded one does — and then
// against the four ways that app could be wrong and still answer 200 somewhere. No server is
// booted here: CI's `scaffold-smoke` job is the real boot.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp/rm and exposes no tmpdir(); each case owns a throwaway app directory.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DEV_BINDING } from '@ultimat3/cli';
import type { AdminWalk } from './lib/admin-walk';
import { adminFindings, filledForm, walkAdmin } from './lib/admin-walk';
import type { AdminCheckIo } from './scaffold-admin';
import { adminResource, appDirWord, checkAdmin, devRoleCookie } from './scaffold-admin';

const BASE = 'http://127.0.0.1:4000';
const WALK: AdminWalk = { base: BASE, resource: 'smoke_resources', roleCookie: 'demo_dev_role' };
const ID = '01a0f95f-bed7-71b8-86ac-08311117ef72';

const FORM = [
  '<form method="get" action="/admin/search"><input name="term" type="search"></form>',
  '<form class="f" method="post" action="/admin/smoke_resources/new">',
  '<input name="title" type="text" value="" required>',
  '<input name="price" type="text" required inputmode="numeric">',
  '<input name="price.currency" type="text" placeholder="Currency" maxlength="3">',
  '<input name="published" type="checkbox">',
  '<button type="submit">Save</button></form>',
].join('');

/** The version the edit form renders — escaped, as the renderer writes an attribute. */
const VERSION = 'h1:key&v';
const EDIT_FORM = [
  `<form class="f" method="post" action="/admin/smoke_resources/${ID}/edit">`,
  '<input type="hidden" name="_version" value="h1:key&amp;v">',
  '<input name="title" type="text" value="smoke row" required>',
  '<button type="submit">Save</button></form>',
].join('');

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly role: string;
  readonly origin: string | null;
  readonly body: string;
}

/** A scaffolded app in thirty lines: one resource, the admin role let in, everyone else refused. */
const fakeApp = (over: Partial<Record<string, (seen: Seen) => Response | undefined>> = {}) => {
  const seen: Seen[] = [];
  const rows: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const one: Seen = {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname,
      role: /demo_dev_role=(\w+)/.exec(headers.get('cookie') ?? '')?.[1] ?? 'none',
      origin: headers.get('origin'),
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
    };
    seen.push(one);
    const special = over[`${one.method} ${one.path} ${one.role}`]?.(one);
    if (special !== undefined) return special;
    if (one.role !== 'admin') return new Response('<h1>Forbidden</h1>', { status: 403 });
    if (one.method === 'POST') {
      const posted = new URLSearchParams(one.body);
      if (posted.get('_operation') === 'delete') {
        // A delete owes the typed confirmation, exactly as the admin's own gate asks it.
        if (posted.get('confirmation') !== `smoke_resources:${ID}`) {
          return new Response('<h1>Forbidden</h1>', { status: 403 });
        }
        rows.splice(rows.indexOf(ID), 1);
        return new Response(null, { status: 303, headers: { location: '/admin/smoke_resources' } });
      }
      // The admin's optimistic check: an edit that does not post back the version it was drawn
      // with is a 409, never a write.
      if (one.path.endsWith('/edit') && posted.get('_version') !== VERSION) {
        return new Response('<p>Someone changed this row after you opened it</p>', { status: 409 });
      }
      if (one.path.endsWith('/new')) rows.push(ID);
      return new Response(null, {
        status: 303,
        headers: { location: `/admin/smoke_resources/${ID}` },
      });
    }
    if (one.path.endsWith('/new')) return new Response(FORM);
    if (one.path.endsWith('/edit')) return new Response(EDIT_FORM);
    return new Response(rows.map((id) => `<tr data-row="${id}"><td>x</td></tr>`).join(''));
  };
  return { fetcher, seen, rows };
};

describe('unit · the admin of a scaffolded app, walked', () => {
  test('an app that serves its generated resource passes every step, and writes one row', async () => {
    const app = fakeApp();
    const steps = await walkAdmin(WALK, app.fetcher);
    expect(steps.map((step) => [step.name, step.ok])).toEqual([
      ['the admin role opens the list', true],
      ['the admin role opens the create form', true],
      ['the admin role creates a row', true],
      ['the list shows the row', true],
      ['the admin role edits the row', true],
      ['the admin role deletes the row', true],
      ['the member role is refused the list', true],
      ['the member role is refused the write', true],
    ]);
    expect(adminFindings('/tmp/demoapp', WALK, steps)).toEqual([]);
    // Created, then deleted through the admin's own confirmation: the table ends as it began.
    expect(app.rows).toEqual([]);
    expect(app.seen.map((one) => `${one.method} ${one.path} ${one.role}`)).toContain(
      `POST /admin/smoke_resources/${ID}/edit admin`,
    );
    // The edit is posted as a browser posts it: the form opened first, its version sent back.
    const edit = app.seen.find((one) => one.method === 'POST' && one.path.endsWith('/edit'));
    expect(new URLSearchParams(edit?.body).get('_version')).toBe(VERSION);
    expect(app.seen.map((one) => `${one.method} ${one.path}`)).toContain(
      `GET /admin/smoke_resources/${ID}/edit`,
    );
    // The write names its own origin: the framework refuses a form post that does not.
    const post = app.seen.find((one) => one.method === 'POST' && one.role === 'admin');
    expect(post?.origin).toBe(BASE);
    expect(new URLSearchParams(post?.body).get('price.currency')).toBe('USD');
  });

  test('a list that lets the member role in is a finding, and it says which step', async () => {
    const leak = fakeApp({
      'GET /admin/smoke_resources member': () => new Response(`<tr data-row="${ID}"></tr>`),
    });
    const steps = await walkAdmin(WALK, leak.fetcher);
    const [finding, ...rest] = adminFindings('/tmp/demoapp', WALK, steps);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_SCAFFOLD_FIRST_RUN_FAILED');
    expect(finding?.cause).toContain('the member role is refused the list');
    expect(finding?.cause).toContain('answered 200');
    expect(finding?.fix).toContain('/tmp/demoapp');
    expect(finding?.fix).toContain("-H 'cookie: demo_dev_role=member'");
  });

  test('a write the member role can make is a finding', async () => {
    const open = fakeApp({
      'POST /admin/smoke_resources/new member': () =>
        new Response(null, { status: 303, headers: { location: '/admin/smoke_resources/x' } }),
    });
    const names = adminFindings('/t', WALK, await walkAdmin(WALK, open.fetcher)).map(
      (finding) => finding.cause,
    );
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('the member role is refused the write');
  });

  test('a create that answers 422 reports what the form said, and the row is not looked for', async () => {
    const refused = fakeApp({
      'POST /admin/smoke_resources/new admin': () =>
        new Response('<div class="x-admin-issues" role="alert"><li>Title: required</li></div>', {
          status: 422,
        }),
    });
    const steps = await walkAdmin(WALK, refused.fetcher);
    const failed = steps.filter((step) => !step.ok).map((step) => step.name);
    expect(failed).toEqual(['the admin role creates a row', 'the list shows the row']);
    const [create] = adminFindings('/t', WALK, steps);
    expect(create?.cause).toContain('answered 422');
    expect(create?.cause).toContain('Title: required');
  });

  // The admin asks a SEPARATE pair of grants for each write. A role map that lets the admin role
  // create and not edit, or edit and not delete, is the half-granted admin this step is for.
  test('an edit or a delete the admin role is refused is a finding of its own', async () => {
    const noEdit = fakeApp({
      [`POST /admin/smoke_resources/${ID}/edit admin`]: () => new Response('', { status: 403 }),
    });
    const edit = (await walkAdmin(WALK, noEdit.fetcher)).filter((step) => !step.ok);
    expect(edit.map((step) => [step.name, step.got])).toEqual([
      ['the admin role edits the row', 'answered 403'],
    ]);

    const noDelete = fakeApp({
      [`POST /admin/smoke_resources/${ID} admin`]: () => new Response('', { status: 403 }),
    });
    const refusedDelete = (await walkAdmin(WALK, noDelete.fetcher)).filter((step) => !step.ok);
    expect(refusedDelete.map((step) => [step.name, step.got])).toEqual([
      ['the admin role deletes the row', 'answered 403'],
    ]);
    expect(refusedDelete[0]?.curl).toContain(`confirmation=smoke_resources%3A${ID}`);
  });

  test('a delete that answers 303 and leaves the row in the list is a finding', async () => {
    const sticky = fakeApp({
      [`POST /admin/smoke_resources/${ID} admin`]: () =>
        new Response(null, { status: 303, headers: { location: '/admin/smoke_resources' } }),
    });
    const failed = (await walkAdmin(WALK, sticky.fetcher)).filter((step) => !step.ok);
    expect(failed.map((step) => step.name)).toEqual(['the admin role deletes the row']);
    expect(failed[0]?.got).toContain('the list still shows');
  });

  test('a row the create redirected to and the list does not show is a finding', async () => {
    const blind = fakeApp({
      'GET /admin/smoke_resources admin': () => new Response('<p>none</p>'),
    });
    const failed = (await walkAdmin(WALK, blind.fetcher)).filter((step) => !step.ok);
    expect(failed.map((step) => step.name)).toEqual(['the list shows the row']);
    expect(failed[0]?.got).toContain(`no data-row="${ID}"`);
  });

  test('a resource with no admin screen fails at the first step and writes nothing', async () => {
    const none = fakeApp({
      'GET /admin/smoke_resources admin': () => new Response('', { status: 404 }),
    });
    const steps = await walkAdmin(WALK, none.fetcher);
    expect(steps[0]).toMatchObject({ ok: false, got: 'answered 404' });
    expect(none.rows).toEqual([]);
  });
});

describe('unit · what the walk reads off the app', () => {
  test('the form is filled from its own fields: text, a number, a currency — never a checkbox', () => {
    const body = filledForm(FORM);
    expect(body?.action).toBe('/admin/smoke_resources/new');
    expect([...(body?.fields ?? [])]).toEqual([
      ['title', 'smoke row'],
      ['price', '100'],
      ['price.currency', 'USD'],
    ]);
    expect(filledForm('<form method="get" action="/admin/search"></form>')).toBeUndefined();
  });

  test('the resource is the one `x g resource` generated, read from the app`s manifest', () => {
    const manifest = { entities: [{ name: 'posts' }, { name: 'smoke_resources' }] };
    expect(adminResource(manifest)).toBe('smoke_resources');
    expect(adminResource({ entities: [{ name: 'posts' }] })).toBeUndefined();
    expect(adminResource('not a manifest')).toBeUndefined();
  });

  test('the role cookie is the one the scaffold`s dev authenticator declares', () => {
    expect(devRoleCookie("export const DEV_ROLE_COOKIE = 'demoapp_dev_role';")).toBe(
      'demoapp_dev_role',
    );
    expect(devRoleCookie('// this app issues real sessions now')).toBeUndefined();
  });
});

describe('unit · the command: boot, walk, stop', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /** An app directory holding only what the check READS; `has` says which of the three. */
  const appDir = async (
    has: readonly ('manifest' | 'actor' | 'bin')[],
    name?: string,
  ): Promise<string> => {
    const parent = await mkdtemp(`${tmpdir()}/scaffold-admin-`);
    dirs.push(parent);
    const dir = name === undefined ? parent : `${parent}/${name}`;
    if (has.includes('manifest')) {
      await Bun.write(`${dir}/x.manifest.json`, '{"entities":[{"name":"smoke_resources"}]}');
    }
    if (has.includes('actor')) {
      await Bun.write(
        `${dir}/apps/web/app/auth/dev-actor.ts`,
        "export const DEV_ROLE_COOKIE = 'demo_dev_role';\n",
      );
    }
    if (has.includes('bin')) await Bun.write(`${dir}/node_modules/.bin/x`, '#!/bin/sh\n');
    return dir;
  };

  /** A boot that answers after `refusals` failed dials, on a clock that moves only when slept. */
  const io = (
    fetcher: AdminCheckIo['fetcher'],
    over: { readonly refusals?: number; readonly dies?: boolean } = {},
  ) => {
    let clock = 0;
    let dials = 0;
    const calls = { booted: [] as [string, number][], stopped: 0 };
    const made: AdminCheckIo = {
      boot: (dir, port) => {
        calls.booted.push([dir, port]);
        return {
          exited: () => over.dies === true && dials > 0,
          stop: () => {
            calls.stopped += 1;
            return Promise.resolve('boot log line 1\nX_CONFIG_INVALID: no database');
          },
        };
      },
      fetcher: (url, init) => {
        if (url.endsWith('/admin') && dials < (over.refusals ?? 0)) {
          dials += 1;
          return Promise.reject(new TypeError('ECONNREFUSED'));
        }
        return fetcher(url, init);
      },
      port: () => 4000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    };
    return { made, calls };
  };

  test('boots the app`s own x dev on a free port, waits for it, walks, and always stops it', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const app = fakeApp();
    const { made, calls } = io(app.fetcher, { refusals: 3 });
    const result = await checkAdmin(dir, made);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain('/admin/smoke_resources lists a row its own form created');
    expect(result.summary).toContain('boot 300 ms');
    expect(calls).toEqual({ booted: [[dir, 4000]], stopped: 1 });
    expect(app.rows).toEqual([]);
    expect(result.lines).toHaveLength(8);
  });

  test('a failed step is a red result that still stopped the server', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const leak = fakeApp({ 'GET /admin/smoke_resources member': () => new Response('ok') });
    const { made, calls } = io(leak.fetcher);
    const result = await checkAdmin(dir, made);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(`1 of 8 admin step(s) failed in ${dir}`);
    expect(result.findings?.[0]?.fix).toContain('bun run dev --port 4000');
    expect(calls.stopped).toBe(1);
  });

  test('an x dev that exits before answering is reported with what it printed, never walked', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const app = fakeApp();
    const { made, calls } = io(app.fetcher, { refusals: 99, dies: true });
    const result = await checkAdmin(dir, made);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(`x dev did not answer in ${dir}`);
    expect(result.findings?.[0]?.cause).toContain('X_CONFIG_INVALID: no database');
    expect(calls.stopped).toBe(1);
    expect(app.seen).toEqual([]);
  });

  test('an x dev that never answers is given up on at the budget, not waited on forever', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const { made, calls } = io(fakeApp().fetcher, { refusals: Number.POSITIVE_INFINITY });
    const result = await checkAdmin(dir, made);
    expect(result.findings?.[0]?.cause).toContain('answered no request in 60000 ms');
    expect(calls.stopped).toBe(1);
  });

  // The CI failure this pins: `x dev` binds `localhost`, which a runner whose hosts file maps it to
  // `::1` too binds as `[::1]` alone — so a dial at `127.0.0.1` was refused for the whole budget.
  test('the app is dialled at the name x dev binds, never a literal loopback address', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const dialled: string[] = [];
    const app = fakeApp();
    const { made } = io((url, init) => {
      dialled.push(new URL(url).hostname);
      return app.fetcher(url, init);
    });
    const result = await checkAdmin(dir, made);
    expect(result.ok).toBe(true);
    expect(dialled.length).toBeGreaterThan(0);
    expect(new Set(dialled)).toEqual(new Set([DEV_BINDING.hostname]));
  });

  test('a budget spent on refused dials says what the last dial was told, and where', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const { made } = io(fakeApp().fetcher, { refusals: Number.POSITIVE_INFINITY });
    const result = await checkAdmin(dir, made);
    const cause = result.findings?.[0]?.cause ?? '';
    expect(cause).toContain(`http://${DEV_BINDING.hostname}:4000/admin`);
    expect(cause).toContain('ECONNREFUSED');
  });

  // Plan 101 row S12: the directory is spliced into `bun run scripts/scaffold-first-run.ts <dir> &&
  // (cd <dir> && bun run setup)`, a line pasted whole — so a path carrying shell syntax is single-quoted.
  test('a hostile directory never reaches the set-up command', async () => {
    const parent = await appDir([]);
    const dir = `${parent}/x$(touch pwned);y`;
    await Bun.write(`${dir}/.keep`, '');
    const { made } = io(fakeApp().fetcher);
    const fix = (await checkAdmin(dir, made)).findings?.[0]?.fix ?? '';
    // Single-quoted, so the hostile path is carried inert rather than lost (L5 of the 1c audit).
    expect(fix).toBe(
      `bun run scripts/scaffold-first-run.ts '${dir}' && (cd '${dir}' && bun run setup)`,
    );
    // A relative path, the common case, stays pasteable; a leading - never becomes a flag.
    const relative = (await checkAdmin('./does-not-exist', io(fakeApp().fetcher).made)).findings;
    expect(relative?.[0]?.fix).toBe(
      'bun run scripts/scaffold-first-run.ts ./does-not-exist && (cd ./does-not-exist && bun run setup)',
    );
    const flag = (await checkAdmin('-rf', io(fakeApp().fetcher).made)).findings;
    expect(flag?.[0]?.fix).toBe(
      "bun run scripts/scaffold-first-run.ts '<app dir>' && (cd '<app dir>' && bun run setup)",
    );
    // An ordinary temp directory still travels verbatim.
    const plain = await appDir(['actor', 'bin']);
    const plainFix = (await checkAdmin(plain, io(fakeApp().fetcher).made)).findings?.[0]?.fix;
    expect(plainFix).toBe(
      `bun run scripts/scaffold-first-run.ts ${plain} && (cd ${plain} && bun run setup)`,
    );
  });

  // CodeRabbit on #651: two of the three fixes still spliced `dir` raw. One helper, three lines.
  test('every fix quotes the directory through the one rule', async () => {
    const hostile = 'x$(touch pwned);y';
    const noBin = await appDir(['manifest', 'actor'], hostile);
    expect((await checkAdmin(noBin, io(fakeApp().fetcher).made)).findings?.[0]?.fix).toBe(
      `cd '${noBin}' && bun run setup`,
    );
    const silent = await appDir(['manifest', 'actor', 'bin'], hostile);
    const { made } = io(fakeApp().fetcher, { refusals: Number.POSITIVE_INFINITY });
    expect((await checkAdmin(silent, made)).findings?.[0]?.fix).toBe(
      `cd '${silent}' && bun run dev --port 4000`,
    );
    expect(appDirWord('-rf')).toBe('<app dir>');
    expect(appDirWord('./my-app')).toBe('./my-app');
  });

  test('a directory that is not a set-up scaffold is refused before anything boots', async () => {
    const cases: readonly (readonly [readonly ('manifest' | 'actor' | 'bin')[], string])[] = [
      [['actor', 'bin'], 'names no entity'],
      [['manifest', 'bin'], 'declares no DEV_ROLE_COOKIE'],
      [['manifest', 'actor'], 'does not exist, so the scaffolded app cannot be booted'],
    ];
    for (const [has, cause] of cases) {
      const { made, calls } = io(fakeApp().fetcher);
      const result = await checkAdmin(await appDir(has), made);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_SCAFFOLD_FIRST_RUN_FAILED');
      expect(result.findings?.[0]?.cause).toContain(cause);
      expect(calls.booted).toEqual([]);
    }
  });
});
