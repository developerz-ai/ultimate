// The batch bar with scripting off: row checkboxes owned by one native form, a radio for "every
// row this list matches", a submit — and the answer a page of counts. A destructive batch, or one
// that takes input, is a server round trip through its form before it runs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  enumerated,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

const tickets = entity('admin_bscreen_tickets', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    state: enumerated(['open', 'closed']),
  },
});
const db = database({ tickets }, { driver: memoryDriver() });
const ran: string[] = [];

let admin: AdminApp;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/bscreen',
    entities: [tickets],
    db,
    actions: [
      {
        name: 'ticket.close',
        permission: 'admin_bscreen_tickets:write',
        entity: 'admin_bscreen_tickets',
        when: (row) => row['state'] === 'open',
        batch: true,
        handle: async ({ input }) => {
          ran.push(`close:${String(input['id'])}`);
        },
      },
      {
        name: 'ticket.note',
        permission: 'admin_bscreen_tickets:write',
        entity: 'admin_bscreen_tickets',
        input: t.object({ note: t.string.min(2) }),
        batch: true,
        handle: async ({ input }) => {
          ran.push(`note:${String(input['id'])}:${String(input['note'])}`);
        },
      },
      {
        name: 'ticket.drop',
        permission: 'admin_bscreen_tickets:delete',
        entity: 'admin_bscreen_tickets',
        destructive: true,
        batch: true,
        handle: async ({ input }) => {
          ran.push(`drop:${String(input['id'])}`);
        },
      },
    ],
  });
});

registerCatalog('en', {
  'admin.admin_bscreen_tickets.title': 'Tickets',
  'admin.batch.done': 'DONE-COUNT',
  'admin.batch.refused': 'REFUSED-COUNT',
  'admin.error.action-not-applicable': 'NOT-APPLICABLE',
});

const OPERATOR: AdminActor = { id: 'u-op', roles: ['bscreen-op'] };
const VIEWER: AdminActor = { id: 'u-view', roles: ['bscreen-view'] };
const BASE = '/bscreen/admin_bscreen_tickets';
const ids: string[] = [];

beforeAll(async () => {
  const read = ['admin:read', 'admin_bscreen_tickets:read'];
  defineRoles({
    ...previousRoles,
    'bscreen-view': { grants: read },
    'bscreen-op': {
      grants: [
        ...read,
        'admin:write',
        'admin:destroy',
        'admin_bscreen_tickets:write',
        'admin_bscreen_tickets:delete',
      ],
    },
  });
  for (const [title, state] of [
    ['A', 'open'],
    ['B', 'open'],
    ['C', 'closed'],
  ] as const) {
    ids.push(String((await db.tickets.insert({ title, state })).id));
  }
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
});

const ask = (
  actor: AdminActor,
  path: string,
  form: Readonly<Record<string, unknown>> | null = null,
): Promise<{ status: number | string; html: string }> =>
  runWithContext(
    createContext({ actor: userActor({ id: actor.id, roles: [...(actor.roles ?? [])] }) }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no route at ${path}`);
      const response: AdminRouteResponse = await matched.route.respond({
        ctx: admin.ctx({ actor, requestId: 'bscreen' }),
        params: matched.params,
        url,
        method: form === null ? 'GET' : 'POST',
        form,
      });
      if (response.kind === 'redirect') return { status: response.location, html: '' };
      const html = await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
      return { status: response.status, html };
    },
  );

describe('unit · the batch bar works with scripting off', () => {
  test('one native form at the list’s URL; each row’s checkbox joins it through `form`', async () => {
    const page = await ask(OPERATOR, `${BASE}?f.state=open`);
    expect(page.html).toContain('id="x-admin-batch"');
    expect(page.html).toMatch(
      /<form id="x-admin-batch"[^>]*method="post"[^>]*action="[^"]*f\.state=open/,
    );
    expect(page.html).toContain(`name="ids" value="${ids[0]}" form="x-admin-batch"`);
    expect(page.html).toContain('name="selection" value="all"');
    expect(page.html).not.toContain('<script');
  });

  test('an actor who may run no batch action gets no bar and no checkbox', async () => {
    const page = await ask(VIEWER, BASE);
    expect(page.html).not.toContain('x-admin-batch"');
    expect(page.html).not.toContain('name="ids"');
  });

  test('checked rows run, and the answer is the counts — a row `when` excludes is refused by name', async () => {
    ran.length = 0;
    const answer = await ask(OPERATOR, BASE, {
      _operation: 'batch',
      name: 'ticket.close',
      selection: 'checked',
      ids: [ids[0], ids[2]],
    });
    expect(answer.status).toBe(200);
    expect(answer.html).toMatch(/DONE-COUNT<\/dt><dd[^>]*>1</);
    expect(answer.html).toMatch(/REFUSED-COUNT<\/dt><dd[^>]*>1</);
    expect(answer.html).toContain('NOT-APPLICABLE');
    expect(ran).toEqual([`close:${ids[0]}`]);
  });

  test('"every row this list matches" reads the URL’s own filter, not the checked rows', async () => {
    ran.length = 0;
    await ask(OPERATOR, `${BASE}?f.state=open`, {
      _operation: 'batch',
      name: 'ticket.close',
      selection: 'all',
    });
    expect([...ran].sort()).toEqual([`close:${ids[0]}`, `close:${ids[1]}`].sort());
  });

  test('an action with input answers with its form first, then runs with what was typed', async () => {
    ran.length = 0;
    const post = { _operation: 'batch', name: 'ticket.note', selection: 'checked', ids: [ids[1]] };
    const form = await ask(OPERATOR, BASE, post);
    expect(form.status).toBe(200);
    expect(form.html).toContain('name="input.note"');
    expect(form.html).toContain(`name="ids" value="${ids[1]}"`);
    expect(ran).toEqual([]);

    const refused = await ask(OPERATOR, BASE, { ...post, _step: 'run', 'input.note': 'x' });
    expect(refused.status).toBe(422);
    expect(ran).toEqual([]);

    const done = await ask(OPERATOR, BASE, { ...post, _step: 'run', 'input.note': 'ok' });
    expect(done.status).toBe(200);
    expect(ran).toEqual([`note:${ids[1]}:ok`]);
  });

  test('a destructive batch is confirmed by a round trip, never inline', async () => {
    ran.length = 0;
    const post = { _operation: 'batch', name: 'ticket.drop', selection: 'checked', ids };
    const asked = await ask(OPERATOR, BASE, post);
    expect(asked.status).toBe(200);
    expect(asked.html).toContain('admin_bscreen_tickets:3 rows');
    expect(ran).toEqual([]);
    const run = await ask(OPERATOR, BASE, {
      ...post,
      _step: 'run',
      confirmation: 'admin_bscreen_tickets:3 rows',
    });
    expect(run.status).toBe(200);
    expect(ran).toHaveLength(3);
  });

  test('a forged batch post from an actor without the grant is 403 and nothing runs', async () => {
    ran.length = 0;
    const answer = await ask(VIEWER, BASE, {
      _operation: 'batch',
      name: 'ticket.close',
      selection: 'checked',
      ids,
    });
    expect(answer.status).toBe(403);
    expect(ran).toEqual([]);
  });

  test('a batch post naming no batch action, or a filter the list does not derive, is refused', async () => {
    expect((await ask(OPERATOR, BASE, { _operation: 'batch', name: 'nope' })).status).toBe(404);
    expect(
      (
        await ask(OPERATOR, `${BASE}?f.nope=A`, {
          _operation: 'batch',
          name: 'ticket.close',
          selection: 'all',
        })
      ).status,
    ).toBe(400);
  });
});
