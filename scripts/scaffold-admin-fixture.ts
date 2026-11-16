// TEST-ONLY. The world `scaffold-admin`'s tests run in: a fake scaffolded app that answers the
// way a real one does, an app directory holding only what the check reads, and an `x dev` that
// boots on a clock that moves only when slept. Shared by the walk and the port-retry suites.

import { tempTrees } from '../packages/testing/src/temp-tree';
import type { AdminWalk } from './lib/admin-walk';
import type { AdminCheckIo } from './scaffold-admin';
import { fixedPort } from './scaffold-admin';

/** One owner for every app directory a suite makes; each suite's `afterAll` disposes it. */
export const trees = tempTrees();

export const BASE = 'http://127.0.0.1:4000';
export const WALK: AdminWalk = {
  base: BASE,
  resource: 'smoke_resources',
  roleCookie: 'demo_dev_role',
};
export const ID = '01a0f95f-bed7-71b8-86ac-08311117ef72';

export const FORM = [
  '<form method="get" action="/admin/search"><input name="term" type="search"></form>',
  '<form class="f" method="post" action="/admin/smoke_resources/new">',
  '<input name="title" type="text" value="" required>',
  '<input name="price" type="text" required inputmode="numeric">',
  '<input name="price.currency" type="text" placeholder="Currency" maxlength="3">',
  '<input name="published" type="checkbox">',
  '<button type="submit">Save</button></form>',
].join('');

/** The version the edit form renders — escaped, as the renderer writes an attribute. */
export const VERSION = 'h1:key&v';
export const EDIT_FORM = [
  `<form class="f" method="post" action="/admin/smoke_resources/${ID}/edit">`,
  '<input type="hidden" name="_version" value="h1:key&amp;v">',
  '<input name="title" type="text" value="smoke row" required>',
  '<button type="submit">Save</button></form>',
].join('');

export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly role: string;
  readonly origin: string | null;
  readonly body: string;
}

/** A scaffolded app in thirty lines: one resource, the admin role let in, everyone else refused. */
export const fakeApp = (
  over: Partial<Record<string, (seen: Seen) => Response | undefined>> = {},
) => {
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

/** An app directory holding only what the check READS; `has` says which of the three. */
export const appDir = async (
  has: readonly ('manifest' | 'actor' | 'bin')[],
  name?: string,
): Promise<string> => {
  const parent = trees.make('scaffold-admin-');
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
export const fakeIo = (
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
    ports: fixedPort(4000),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  return { made, calls };
};
