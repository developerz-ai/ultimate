// A reference cell shows the TARGET's label, and a page of them is one read per target — never
// one per row. The assertion is the statement count, taken at the driver: every call the typed
// handle makes to a table is one statement, and the ledger below records each of them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  type Driver,
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
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

/** Every call a table makes to its repository, as `<entity>.<method>`. One entry, one statement. */
const statements: string[] = [];

const counting = (inner: Driver): Driver => ({
  transactor: () => inner.transactor(),
  repo: (declared) =>
    new Proxy(inner.repo(declared), {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== 'function' || typeof property !== 'string') return member;
        return (...args: readonly unknown[]): unknown => {
          statements.push(`${declared.$name}.${property}`);
          return Reflect.apply(member, target, args);
        };
      },
    }),
});

const owners = entity('admin_rel_owners', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});
const teams = entity('admin_rel_teams', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});
const tickets = entity('admin_rel_tickets', {
  columns: {
    id: uuid().primaryKey(),
    ownerId: uuid().references(() => owners.id),
    teamId: uuid().references(() => teams.id),
    title: text({ max: 120 }),
    status: enumerated(['open', 'closed']).default('open'),
  },
});

const db = database({ owners, teams, tickets }, { driver: counting(memoryDriver()) });

let admin: AdminApp;
beforeAll(() => {
  admin = defineAdmin({
    entities: [owners, teams, tickets],
    db,
    resources: {
      admin_rel_tickets: {
        pageSize: 50,
        listFields: ['title', 'ownerId', 'teamId', 'status'],
        scopes: {
          open: { where: [{ field: 'status', op: 'eq', value: 'open' }], count: true },
          closed: { where: [{ field: 'status', op: 'eq', value: 'closed' }] },
          mine: { where: (actor) => [{ field: 'title', op: 'contains', value: actor.id }] },
        },
      },
    },
  });
});

registerCatalog('en', {
  'admin.admin_rel_tickets.title': 'Tickets',
  'admin.admin_rel_tickets.field.title': 'Title',
  'admin.admin_rel_tickets.field.ownerId': 'Owner',
  'admin.admin_rel_tickets.field.teamId': 'Team',
  'admin.admin_rel_tickets.field.status': 'Status',
  'admin.admin_rel_tickets.scope.open': 'Open',
  'admin.admin_rel_tickets.scope.closed': 'Closed',
  'admin.admin_rel_tickets.scope.mine': 'Mine',
  'admin.admin_rel_owners.title': 'Owners',
  'admin.admin_rel_teams.title': 'Teams',
});

const BASE = '/admin/admin_rel_tickets';
const ownerIds: string[] = [];

beforeAll(async () => {
  defineRoles({
    ...previousRoles,
    reader: {
      grants: [
        'admin:read',
        'admin_rel_tickets:read',
        'admin_rel_owners:read',
        'admin_rel_teams:read',
      ],
    },
    // May list tickets and nothing they reference.
    narrow: { grants: ['admin:read', 'admin_rel_tickets:read'] },
  });
  for (let index = 0; index < 10; index += 1) {
    ownerIds.push(String((await db.owners.insert({ name: `Owner ${index}` })).id));
  }
  const team = String((await db.teams.insert({ name: 'Platform' })).id);
  for (let index = 0; index < 50; index += 1) {
    await db.tickets.insert({
      ownerId: ownerIds[index % 10] ?? '',
      teamId: team,
      title: `Ticket ${index}`,
    });
  }
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

interface Answer {
  readonly response: AdminRouteResponse;
  readonly html: string;
  /** The statements this one request issued, in order. */
  readonly issued: readonly string[];
}

const ask = (role: string, path: string): Promise<Answer> =>
  runWithContext(
    ctxOf({
      actor: userActor({ id: `u-${role}`, roles: [role] }),
      tz: 'UTC',
      locale: 'en',
    }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const from = statements.length;
      const response = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      const issued = statements.slice(from);
      const html =
        response.kind === 'document'
          ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
          : '';
      return { response, html, issued };
    },
  );

describe('unit · a reference cell shows the target’s label, read in one batch', () => {
  test('50 rows referencing 10 owners issue ONE read of owners — not 50, and not 10', async () => {
    const answer = await ask('reader', BASE);
    expect(answer.issued.filter((one) => one.startsWith('admin_rel_owners.'))).toHaveLength(1);
    expect(answer.issued.filter((one) => one.startsWith('admin_rel_teams.'))).toHaveLength(1);
    // The label, linked to the target — and the raw foreign key nowhere in a cell.
    expect(answer.html).toContain(`<a href="/admin/admin_rel_owners/${ownerIds[3]}">Owner 3</a>`);
    expect(answer.html).toContain('Platform</a>');
  });

  test('the whole page: 50 rows, 2 reference columns, 3 scopes (1 counted) is 4 statements', async () => {
    const answer = await ask('reader', BASE);
    expect([...answer.issued].sort()).toEqual([
      // One read per referenced target: a target of at most 50 rows is read whole, once, and
      // that one read is both the filter's option list and every label on the page.
      'admin_rel_owners.findMany',
      'admin_rel_teams.findMany',
      // The one scope that asked for a count, and no other.
      'admin_rel_tickets.count',
      // The page itself.
      'admin_rel_tickets.findMany',
    ]);
    // The counted tab carries its number; the two that did not ask carry none.
    expect(answer.html).toMatch(/Open\s*<span[^>]*>50<\/span>/);
    expect(answer.html).not.toMatch(/Closed\s*<span/);
  });

  test('the small target is the reference filter’s <select>, by label — no option list in the app', async () => {
    const answer = await ask('reader', BASE);
    expect(answer.html).toContain('name="f.ownerId"');
    expect(answer.html).toContain(`<option value="${ownerIds[0]}">Owner 0</option>`);
    // The enum filter's options are the entity's own values.
    expect(answer.html).toContain('name="f.status"');
    expect(answer.html).toContain('<option value="closed">');
  });

  test('a target past the select ceiling costs one more read, and the filter becomes a lookup link', async () => {
    for (let index = 10; index < 60; index += 1) await db.owners.insert({ name: `Owner ${index}` });
    const answer = await ask('reader', BASE);
    // The probe that found it too large, then the labels of the ids on the page.
    expect(answer.issued.filter((one) => one.startsWith('admin_rel_owners.'))).toHaveLength(2);
    expect(answer.issued).toHaveLength(5);
    expect(answer.html).toContain('>Owner 3</a>');
    expect(answer.html).not.toContain(`<option value="${ownerIds[0]}">`);
    expect(answer.html).toContain('href="/admin/admin_rel_owners/lookup?return=');
  });

  test('a target the actor may not read is an id with no name, no link and no read', async () => {
    const answer = await ask('narrow', BASE);
    expect(answer.issued.filter((one) => !one.startsWith('admin_rel_tickets.'))).toEqual([]);
    expect(answer.html).toContain(ownerIds[3] ?? 'no owner id');
    expect(answer.html).not.toContain('Owner 3');
    expect(answer.html).not.toContain('admin_rel_owners/lookup');
  });
});

describe('unit · the lookup screen is the picker, with no script', () => {
  test('a term narrows by the label; each result links back with the filter set', async () => {
    const back = encodeURIComponent(`${BASE}?scope=open&cursor=stale`);
    const answer = await ask(
      'reader',
      `/admin/admin_rel_owners/lookup?term=Owner+4&return=${back}&as=f.ownerId`,
    );
    expect(answer.response.kind === 'document' && answer.response.status).toBe(200);
    // `Owner 4` and `Owner 4x`, never `Owner 3`.
    expect(answer.html).toContain('Owner 4');
    expect(answer.html).not.toContain('Owner 3<');
    // Back to the list it came from: the scope kept, the stale cursor dropped, the id set.
    expect(answer.html).toContain(`href="${BASE}?scope=open&amp;f.ownerId=${ownerIds[4]}"`);
    expect(answer.html).not.toContain('<script');
  });

  test('`return` is held to the admin’s own paths — never somebody else’s page', async () => {
    const answer = await ask(
      'reader',
      '/admin/admin_rel_owners/lookup?return=https%3A%2F%2Fevil.example%2F&as=f.ownerId',
    );
    expect(answer.response.kind === 'document' && answer.response.status).toBe(400);
    expect(answer.html).toContain('X_ADMIN_FILTER_INVALID');
    expect(answer.html).not.toContain('href="https://evil.example');
  });

  test('it pages by keyset, and the next link keeps the term and the way back', async () => {
    // 60 owners by now, 50 to a page.
    const back = encodeURIComponent(BASE);
    const first = await ask(
      'reader',
      `/admin/admin_rel_owners/lookup?term=Owner&return=${back}&as=f.ownerId`,
    );
    const next = /<a href="([^"]+)"[^>]*rel="next"/.exec(first.html)?.[1]?.replaceAll('&amp;', '&');
    expect(next).toContain('/admin/admin_rel_owners/lookup?term=Owner&return=');
    expect(next).toContain('&as=f.ownerId&cursor=');
    const second = await ask('reader', next ?? '');
    expect(second.response.kind === 'document' && second.response.status).toBe(200);
    expect(second.html).toContain('rel="prev"');
    // The second page's results still link back to the list with the filter set.
    expect(second.html).toContain(`href="${BASE}?f.ownerId=`);
  });

  test('opened on its own, a result opens the row', async () => {
    const answer = await ask('reader', '/admin/admin_rel_owners/lookup?term=Owner+4');
    expect(answer.html).toContain(`href="/admin/admin_rel_owners/${ownerIds[4]}"`);
  });

  test('`return` and `as` come together, `as` is a filter parameter, and nothing else is read', async () => {
    for (const [search, said] of [
      [`?return=${encodeURIComponent(BASE)}`, 'are given together or not at all'],
      [`?return=${encodeURIComponent(BASE)}&as=cursor`, 'is not a filter parameter'],
      ['?page=2', 'is not a parameter a lookup reads'],
    ] as const) {
      const answer = await ask('reader', `/admin/admin_rel_owners/lookup${search}`);
      expect({
        search,
        status: answer.response.kind === 'document' && answer.response.status,
      }).toEqual({ search, status: 400 });
      expect(answer.html).toContain(said);
    }
  });

  test('an actor who may not list the target is refused, and nothing is read', async () => {
    const answer = await ask('narrow', '/admin/admin_rel_owners/lookup?term=Owner');
    expect(answer.response.kind === 'document' && answer.response.status).toBe(403);
    expect(answer.issued).toEqual([]);
  });
});
