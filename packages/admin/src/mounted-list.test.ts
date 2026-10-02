// The list an operator works in, as it is SERVED: a filter per derived shape with no option list
// written in the app, scope tabs and sort headers as links, a refusal for a parameter the
// resource does not derive — and not one script. Plus the two papercuts the mounted screens had:
// a tenant column drawn as an input, and a mistyped id answered as an invariant violation.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  boolean,
  clearRegistry,
  database,
  entity,
  enumerated,
  integer,
  memoryDriver,
  money,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

const ORG = '0190a000-0000-7000-8000-0000000000aa';

const vendors = entity('admin_served_vendors', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), name: text({ max: 80 }) },
});

const invoices = entity('admin_served_invoices', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    vendorId: uuid().references(() => vendors.id),
    number: text({ max: 40 }),
    status: enumerated(['draft', 'sent', 'paid']).default('draft'),
    disputed: boolean().default(false),
    lines: integer().default(1),
    total: money(),
    issuedAt: timestamp().defaultNow(),
  },
});

const db = database({ vendors, invoices }, { driver: memoryDriver() });

const ran: string[] = [];

const admin = defineAdmin({
  entities: [vendors, invoices],
  db,
  actions: [
    {
      name: 'invoice.send',
      permission: 'admin_served_invoices:write',
      entity: 'admin_served_invoices',
      handle: async ({ input }) => {
        ran.push(String(input['id']));
      },
    },
  ],
  resources: {
    admin_served_invoices: {
      labelField: 'number',
      listFields: ['number', 'vendorId', 'status', 'issuedAt'],
      fields: { issuedAt: { filterable: true }, total: { currency: 'EUR' } },
      columns: {
        gross: { value: (row) => row['total'], render: 'money' },
        state: {
          value: (row) => ({
            label: String(row['status']).toUpperCase(),
            tone: row['status'] === 'paid' ? 'success' : 'warning',
          }),
          render: 'badge',
        },
        age: { value: (row) => row['issuedAt'], render: 'relative-time' },
        memo: { value: (row) => `${String(row['number'])} `.repeat(30), render: 'truncate' },
        vendor: {
          value: (row) => ({ href: `/vendors/${String(row['vendorId'])}`, label: 'Open vendor' }),
          render: 'link',
        },
        raw: { value: (row) => ({ lines: row['lines'] }), render: 'json' },
        custom: { value: (row) => row['lines'], render: (props) => `×${String(props.value)}` },
      },
      scopes: {
        unpaid: { where: [{ field: 'status', op: 'neq', value: 'paid' }], default: true },
        all: { where: [] },
      },
    },
  },
});

registerCatalog('en', {
  'admin.admin_served_invoices.title': 'Invoices',
  'admin.admin_served_invoices.field.number': 'Number',
  'admin.admin_served_invoices.field.vendorId': 'Vendor',
  'admin.admin_served_invoices.field.status': 'Status',
  'admin.admin_served_invoices.field.disputed': 'Disputed',
  'admin.admin_served_invoices.field.lines': 'Lines',
  'admin.admin_served_invoices.field.total': 'Total',
  'admin.admin_served_invoices.field.issuedAt': 'Issued',
  'admin.admin_served_invoices.field.status.option.paid': 'Paid in full',
  'admin.admin_served_invoices.column.gross': 'Gross',
  'admin.admin_served_invoices.column.state': 'State',
  'admin.admin_served_invoices.column.age': 'Age',
  'admin.admin_served_invoices.column.memo': 'Memo',
  'admin.admin_served_invoices.column.vendor': 'Vendor page',
  'admin.admin_served_invoices.column.raw': 'Raw',
  'admin.admin_served_invoices.column.custom': 'Custom',
  'admin.admin_served_invoices.scope.unpaid': 'Unpaid',
  'admin.admin_served_invoices.scope.all': 'Everything',
  'admin.action.invoice.send': 'Send',
  'admin.admin_served_vendors.title': 'Vendors',
  'admin.admin_served_vendors.field.name': 'Name',
});

const BASE = '/admin/admin_served_invoices';
let vendorId = '';

const asOrg = <T>(run: () => Promise<T>, role = 'clerk'): Promise<T> =>
  runWithContext(
    createContext({
      actor: userActor({ id: `u-${role}`, roles: [role], orgId: ORG }),
      tz: 'UTC',
      locale: 'en',
    }),
    run,
  );

beforeAll(async () => {
  defineRoles({
    ...previousRoles,
    clerk: {
      grants: [
        'admin:read',
        'admin:write',
        'admin:destroy',
        'admin_served_invoices:read',
        'admin_served_invoices:write',
        'admin_served_invoices:delete',
        'admin_served_vendors:read',
        'admin_served_vendors:write',
      ],
    },
  });
  defineRoles({
    ...roleDefinitions(),
    // View-only is a ROLE under the default `roleAuthz()`: the two `:read` grants and nothing else.
    auditor: { grants: ['admin:read', 'admin_served_invoices:read', 'admin_served_vendors:read'] },
    // One grant richer — the table's write WITHOUT the admin's.
    halfway: {
      grants: ['admin:read', 'admin_served_invoices:read', 'admin_served_invoices:write'],
    },
  });
  await asOrg(async () => {
    vendorId = String((await db.vendors.insert({ orgId: ORG, name: 'Acme' })).id);
    const base = { orgId: ORG, vendorId, total: { minor: 1250n, currency: 'EUR' } };
    await db.invoices.insert({ ...base, number: 'INV-001', status: 'paid' });
    await db.invoices.insert({ ...base, number: 'INV-002', status: 'sent', disputed: true });
    await db.invoices.insert({ ...base, number: 'INV-003', lines: 4 });
  });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
});

interface Answer {
  readonly response: AdminRouteResponse;
  readonly html: string;
}

const ask = (
  path: string,
  form?: Readonly<Record<string, unknown>>,
  role = 'clerk',
): Promise<Answer> =>
  asOrg(async () => {
    const url = `http://localhost${path}`;
    const matched = adminRouteMatch(admin, new URL(url).pathname);
    if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
    const response = await matched.route.respond({
      ctx: await admin.requestCtx(new Request(url)),
      params: matched.params,
      url,
      method: form === undefined ? 'GET' : 'POST',
      form: form ?? null,
    });
    const html =
      response.kind === 'document'
        ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
        : '';
    return { response, html };
  }, role);

const statusOf = (answer: Answer): number | string =>
  answer.response.kind === 'document' ? answer.response.status : answer.response.location;

describe('unit · a working filter per shape, with no option list written in the app', () => {
  test('one GET form; an enum is a select of the entity’s own values, a reference a picker, a timestamp a range', async () => {
    const { html } = await ask(BASE);
    expect(html).toContain(`<form class="`);
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/admin\/admin_served_invoices"/);
    // The label first: the list's search box is its `contains` filter.
    expect(html).toMatch(/name="f\.number"[^>]*type="search"|type="search"[^>]*name="f\.number"/);
    // An enum: the entity's values, labelled by the catalog where it has a label.
    expect(html).toContain('name="f.status"');
    expect(html).toContain('<option value="draft">draft</option>');
    expect(html).toContain('<option value="paid">Paid in full</option>');
    // A reference: the target's rows, by label.
    expect(html).toContain('name="f.vendorId"');
    expect(html).toContain(`<option value="${vendorId}">Acme</option>`);
    // A boolean, and a timestamp as a from/to range typed in UTC.
    expect(html).toContain('name="f.disputed"');
    expect(html).toContain('name="f.issuedAt.gte"');
    expect(html).toContain('name="f.issuedAt.lte"');
    expect(html).toContain('type="datetime-local"');
    // The tenant column and the money column are not filters.
    expect(html).not.toContain('name="f.orgId"');
    expect(html).not.toContain('name="f.total"');
  });

  test('each filter narrows the rows, and the control comes back holding what was asked', async () => {
    const enumerated = await ask(`${BASE}?scope=all&f.status=paid`);
    expect(enumerated.html).toContain('INV-001');
    expect(enumerated.html).not.toContain('INV-002');
    expect(enumerated.html).toMatch(/<option value="paid" selected[^>]*>Paid in full/);

    const reference = await ask(`${BASE}?scope=all&f.vendorId=${vendorId}&f.disputed=true`);
    expect(reference.html).toContain('INV-002');
    expect(reference.html).not.toContain('INV-003');

    const future = await ask(`${BASE}?scope=all&f.issuedAt.gte=2999-01-01T00:00`);
    expect(future.html).not.toContain('INV-00');
    expect(future.html).toContain('value="2999-01-01T00:00"');

    const search = await ask(`${BASE}?scope=all&f.number=003`);
    expect(search.html).toContain('INV-003');
    expect(search.html).not.toContain('INV-001');
  });

  test('scope tabs and sort headers are links that keep the list’s state — and the page has no script', async () => {
    const { html } = await ask(`${BASE}?f.status=sent`);
    // The default scope was applied: the paid invoice is not on the bare list.
    expect(html).toContain('INV-002');
    expect(html).toContain(`href="${BASE}?scope=all&amp;f.status=sent"`);
    expect(html).toMatch(/scope=unpaid&amp;f\.status=sent" aria-current="page">Unpaid/);
    // A sortable header is an anchor at the next state of the cycle.
    expect(html).toContain(`href="${BASE}?f.status=sent&amp;sort=issuedAt%3Aasc"`);
    // An unindexed text column is not sortable, so its header is text and not a link.
    expect(html).toContain('<th scope="col" aria-sort="none">Number</th>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<button type="button"(?![^>]*disabled)/);
  });

  test('an unknown filter or sort is a 400 naming what the list answers — never the unfiltered list', async () => {
    for (const search of ['?f.colour=red', '?sort=memo:asc', '?scope=archived', '?page=2']) {
      const answer = await ask(`${BASE}${search}`);
      expect({ search, status: statusOf(answer) }).toEqual({ search, status: 400 });
      expect(answer.html).toContain('X_ADMIN_FILTER_INVALID');
      expect(answer.html).not.toContain('INV-00');
    }
    const named = await ask(`${BASE}?f.colour=red`);
    expect(named.html).toContain('f.number, f.id, f.vendorId, f.status, f.disputed, f.issuedAt');
  });
});

describe('unit · relation labels and computed columns', () => {
  test('a reference cell is the target’s label, linked; an enum cell is a badge', async () => {
    const { html } = await ask(`${BASE}?scope=all`);
    expect(html).toContain(`<a href="/admin/admin_served_vendors/${vendorId}">Acme</a>`);
    expect(html).toContain('Paid in full</span>');
  });

  test('the six renderers, and a component for the seventh', async () => {
    const { html } = await ask(`${BASE}?scope=all&f.number=INV-001`);
    expect(html).toContain('12.50'); // money
    expect(html).toContain('PAID</span>'); // badge, with its tone
    expect(html).toMatch(/<time[^>]*datetime="/); // relative-time
    expect(html).toContain('…</span>'); // truncate
    expect(html).toContain(`<a href="/vendors/${vendorId}">Open vendor</a>`); // link
    expect(html).toContain('<pre class="x-admin-json">{"lines":1}</pre>'); // json
    expect(html).toContain('×1'); // a component
  });
});

describe('unit · the tenant column is the handle’s, never an input', () => {
  test('the create form carries no orgId field, and the row is stamped with the actor’s tenant', async () => {
    const form = await ask('/admin/admin_served_vendors/new');
    expect(statusOf(form)).toBe(200);
    expect(form.html).toContain('name="name"');
    expect(form.html).not.toContain('name="orgId"');

    const created = await ask('/admin/admin_served_vendors/new', { name: 'Globex' });
    expect(created.response.kind).toBe('redirect');
    const [made] = await asOrg(() => db.vendors.where({ name: 'Globex' }).all());
    expect(made?.orgId).toBe(ORG);
  });

  test('a posted orgId cannot choose the tenant, on a create or on an edit', async () => {
    const OTHER = '0190a000-0000-7000-8000-0000000000bb';
    const created = await ask('/admin/admin_served_vendors/new', { name: 'Initech', orgId: OTHER });
    expect(created.response.kind).toBe('redirect');
    const [made] = await asOrg(() => db.vendors.where({ name: 'Initech' }).all());
    expect(made?.orgId).toBe(ORG);

    const edited = await ask(`/admin/admin_served_vendors/${String(made?.id)}/edit`, {
      name: 'Initech II',
      orgId: OTHER,
    });
    expect(statusOf(edited)).toBe(`/admin/admin_served_vendors/${String(made?.id)}`);
    const [stored] = await asOrg(() => db.vendors.where({ id: String(made?.id) }).all());
    expect(stored?.orgId).toBe(ORG);
    expect(stored?.name).toBe('Initech II');
  });

  test('a reference input on a form is a select of the small target', async () => {
    const form = await ask(`${BASE}/new`);
    expect(form.html).toContain('name="vendorId"');
    expect(form.html).toContain(`<option value="${vendorId}">Acme</option>`);
  });
});

describe('unit · view-only is a role, never a mode', () => {
  test('a role holding only the `:read` grants reads, and is refused create, update, delete and an action', async () => {
    const [row] = await asOrg(() => db.invoices.where({ number: 'INV-002' }).all());
    const id = String(row?.id);
    const list = await ask(`${BASE}?scope=all`, undefined, 'auditor');
    expect(statusOf(list)).toBe(200);
    expect(list.html).toContain('INV-002');
    // Nothing to press: no create link, no action form.
    expect(list.html).not.toContain(`${BASE}/new`);
    expect(list.html).not.toContain('method="post"');
    expect(statusOf(await ask(`${BASE}/${id}`, undefined, 'auditor'))).toBe(200);

    const total = { total: '100', 'total.currency': 'EUR' };
    const refusals: readonly (readonly [string, Answer, string])[] = [
      [
        'create',
        await ask(`${BASE}/new`, { number: 'NOPE', vendorId, ...total }, 'auditor'),
        'admin:write',
      ],
      [
        'update',
        await ask(`${BASE}/${id}/edit`, { number: 'NOPE', ...total }, 'auditor'),
        'admin:write',
      ],
      [
        'delete',
        await ask(
          `${BASE}/${id}`,
          { _operation: 'delete', confirmation: `admin_served_invoices:${id}` },
          'auditor',
        ),
        'admin:destroy',
      ],
      [
        'action',
        await ask(`${BASE}/${id}`, { _operation: 'action', name: 'invoice.send' }, 'auditor'),
        'admin:write',
      ],
    ];
    for (const [write, answer, permission] of refusals) {
      expect({ write, status: statusOf(answer) }).toEqual({ write, status: 403 });
      // The refusal names the gate the role lacks — the admin's own, asked before the table's.
      expect(answer.html).toContain(permission);
    }
    // Nothing moved: the row is the row it was, no row was made, and the action never ran.
    expect((await asOrg(() => db.invoices.where({ id }).one()))?.number).toBe('INV-002');
    expect(await asOrg(() => db.invoices.where({ number: 'NOPE' }).count())).toBe(0);
    expect(ran).toEqual([]);
  });

  test('the table’s write grant without the admin’s is still a refusal', async () => {
    const answer = await ask(
      `${BASE}/new`,
      { number: 'NOPE', vendorId, total: '100', 'total.currency': 'EUR' },
      'halfway',
    );
    expect(statusOf(answer)).toBe(403);
    expect(answer.html).toContain('admin:write');
  });
});

describe('unit · a refused form re-renders, whatever was left empty', () => {
  test('a required money field left empty is a 422 naming it — not a 500 out of the money widget', async () => {
    const answer = await ask(`${BASE}/new`, { number: 'INV-900', vendorId, total: '' });
    expect(statusOf(answer)).toBe(422);
    expect(answer.html).toContain('x-admin-issues');
    expect(answer.html).toContain('value="INV-900"');
  });
});

describe('unit · a malformed id in an admin URL is the admin’s 404', () => {
  test('detail, edit, and both posted writes — never X_INVARIANT_VIOLATED', async () => {
    const bad = `${BASE}/not-a-uuid`;
    for (const answer of [
      await ask(bad),
      await ask(`${bad}/edit`),
      await ask(`${bad}/edit`, { number: 'X' }),
      await ask(bad, { _operation: 'delete', confirmation: 'admin_served_invoices:not-a-uuid' }),
    ]) {
      expect(statusOf(answer)).toBe(404);
      expect(answer.html).not.toContain('X_INVARIANT_VIOLATED');
    }
  });
});
