// The list screen. The states a server-rendered table has, and the navigation rules the admin is
// built on: a row opens through a REAL `<a href>` (so a middle-click, a keyboard and a crawler
// all work), paging is prev/next cursor LINKS with no page number — because there is no offset —
// and nothing on the page is a control that needs a script to act.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import { type AdminActor, type AdminAuthz, type AdminDecision, allowed, denied } from './authz';
import type { AdminField } from './fields';
import {
  byComponent,
  installFactory,
  one,
  renderShallowNodes,
  restoreFactory,
  shallowNodesOf,
} from './inert-jsx-fixture';
import { type ListLocation, listHref } from './list-request';
import type { AdminPage } from './pagination';
import type { AdminAction, AdminRow } from './registry';
import type { AdminResource } from './resource';

// Loaded after `@ultimat3/render` installs its `Bun.plugin`, for the reason
// `detail-render.test.ts` states — a plugin only transforms modules loaded after it.
await import('@ultimat3/render/server');
const { AdminList } = await import('./list');

registerCatalog('en', {
  'admin.post.title': 'Posts (probe)',
  'admin.list.empty': 'No rows (probe)',
  'admin.list.open': 'Open (probe)',
  'admin.actions.label': 'Actions (probe)',
  'admin.post.field.title': 'Title (probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

const titleField: AdminField = {
  entity: 'post',
  name: 'title',
  type: 'text',
  widget: 'text-input',
  labelKey: 'admin.post.field.title',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: true,
  searchable: true,
};

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'post:publish',
  entity: 'post',
  handle: async () => undefined,
};

const resourceWith = (actions: readonly AdminAction[]): AdminResource =>
  ({
    name: 'post',
    path: '/posts',
    titleKey: 'admin.post.title',
    idField: 'id',
    listFields: [titleField],
    filters: [],
    scopes: [],
    columns: [],
    secretFields: [],
    actions,
  }) as unknown as AdminResource;

const resource = resourceWith([]);

const ACTOR: AdminActor = { id: 'u_1', roles: ['viewer'], orgId: 'org_1' };
const refuseAll: AdminAuthz = {
  decide: (query): AdminDecision => denied(query.permission, 'probe.refused'),
};

const pageOf = (over: Partial<AdminPage<AdminRow>> = {}): AdminPage<AdminRow> =>
  ({
    rows: [{ id: 'p_1', title: 'First' }],
    sort: { field: 'id', direction: 'desc' },
    pageSize: 25,
    nextCursor: 'cur_next',
    prevCursor: null,
    hasMore: true,
    ...over,
  }) as AdminPage<AdminRow>;

type Nodes = ReturnType<typeof shallowNodesOf>;

const render = (over: Record<string, unknown> = {}): Nodes =>
  renderShallowNodes(AdminList, {
    resource,
    page: pageOf(),
    error: null,
    ctx: { timeZone: 'UTC', locale: 'en-US' },
    actor: ACTOR,
    authz: refuseAll,
    basePath: '/back-office',
    request: {},
    scope: null,
    counts: new Map(),
    hrefFor: (location: ListLocation) => listHref('/back-office', resource, location),
    ...over,
  });

const table = (nodes: Nodes): ReturnType<typeof one> =>
  one(byComponent(nodes, 'DataTable'), '<DataTable>');

interface Column {
  readonly key: string;
  readonly header: string;
  readonly sortable?: boolean;
  cell(row: AdminRow): unknown;
}

const columnsOf = (nodes: Nodes): readonly Column[] =>
  table(nodes).props['columns'] as readonly Column[];

describe('the states', () => {
  test('an error wins over the page', () => {
    const nodes = render({
      error: { code: 'X_ADMIN_DENIED', cause: 'no grant', fix: 'ask an owner' },
    });
    const state = one(byComponent(nodes, 'ErrorState'), '<ErrorState>');
    expect((state.props['error'] as { code: string }).code).toBe('X_ADMIN_DENIED');
    expect(byComponent(nodes, 'DataTable')).toHaveLength(0);
  });

  test('a page with no rows says so instead of rendering an empty grid', () => {
    const nodes = render({ page: pageOf({ rows: [], hasMore: false, nextCursor: null }) });
    expect(byComponent(nodes, 'DataTable')).toHaveLength(0);
    expect(nodes.filter((node) => node.type === 'p').map((node) => node.props['children'])).toEqual(
      ['No rows (probe)'],
    );
  });
});

describe('a row opens through a real link', () => {
  test('the first column is an anchor at basePath + resource path + row id', () => {
    const [open] = columnsOf(render());
    expect(open?.key).toBe('open');
    expect(open?.header).toBe('Open (probe)');
    const anchor = one(shallowNodesOf(open?.cell({ id: 'p_1', title: 'First' })), 'the link');
    expect(anchor.type).toBe('a');
    expect(anchor.props['href']).toBe('/back-office/posts/p_1');
  });

  test('it carries NO click handler — on a page that never hydrates one could not run', () => {
    const [open] = columnsOf(render());
    const anchor = one(shallowNodesOf(open?.cell({ id: 'p_1', title: 'First' })), 'the link');
    expect(Object.keys(anchor.props).filter((name) => name.startsWith('on'))).toEqual([]);
  });

  test('the id comes from the resource idField, not from a hardcoded "id"', () => {
    const keyed = { ...resource, idField: 'slug' } as unknown as AdminResource;
    const [open] = columnsOf(render({ resource: keyed }));
    const anchor = one(shallowNodesOf(open?.cell({ slug: 'hello', title: 'x' })), 'the link');
    expect(anchor.props['href']).toBe('/back-office/posts/hello');
  });
});

describe('the derived columns', () => {
  test('one column per list field, headed by its own label key, rendering through <Widget>', () => {
    const columns = columnsOf(render());
    expect(columns.map((column) => column.key)).toEqual(['open', 'title']);
    expect(columns[1]?.header).toBe('Title (probe)');
    const cell = one(
      byComponent(shallowNodesOf(columns[1]?.cell({ id: 'p_1', title: 'First' })), 'Widget'),
      '<Widget>',
    );
    expect(cell.props['mode']).toBe('read');
    expect(cell.props['value']).toBe('First');
  });

  test('a sortable field sorts by LINK — the next state as a URL, and no callback', () => {
    expect(columnsOf(render()).find((column) => column.key === 'title')?.sortable).toBe(true);
    const props = table(render()).props;
    // The current order still reaches the table, so the header it sorts by is announced.
    expect(props['sort']).toEqual({ key: 'id', direction: 'desc' });
    expect(props['onSortChange']).toBeUndefined();
    const sortHrefFor = props['sortHrefFor'] as (sort?: {
      key: string;
      direction: string;
    }) => string;
    expect(sortHrefFor({ key: 'title', direction: 'asc' })).toBe(
      '/back-office/posts?sort=title%3Aasc',
    );
    // The cycle's third step is "unsorted": the list with no sort in its URL.
    expect(sortHrefFor(undefined)).toBe('/back-office/posts');
  });

  test('a computed column is drawn after the fields, from a row with no sealed value', () => {
    const computed = {
      ...resource,
      secretFields: [{ name: 'apiKey' }],
      columns: [
        {
          name: 'shout',
          labelKey: 'admin.post.field.title',
          value: (row: AdminRow) => `${String(row['title'])}!${String(row['apiKey'])}`,
          render: 'truncate',
        },
      ],
    } as unknown as AdminResource;
    const columns = columnsOf(render({ resource: computed }));
    expect(columns.map((column) => column.key)).toEqual(['open', 'title', 'shout']);
    const cell = one(
      byComponent(
        shallowNodesOf(columns[2]?.cell({ id: 'p_1', title: 'First', apiKey: 'CANARY' })),
        'ComputedCell',
      ),
      '<ComputedCell>',
    );
    // The sealed column is gone from the row the column's `value` is handed.
    expect(cell.props['row']).toEqual({ id: 'p_1', title: 'First' });
  });
});

describe('scopes and filters are the URL', () => {
  const asked = {
    scope: 'open',
    sort: { field: 'title', direction: 'asc' },
    filters: [{ field: 'title', op: 'contains', value: 'fi' }],
  };
  const filtering = {
    ...resource,
    filters: [{ ...titleField, filterable: true, filterKind: 'text' }],
  } as unknown as AdminResource;
  const hrefFor = (location: ListLocation): string => listHref('/back-office', filtering, location);

  test('a cursor link keeps the scope, the filters and the sort it is a position in', () => {
    const props = table(render({ resource: filtering, request: asked, hrefFor })).props;
    expect((props['hrefFor'] as (cursor: string) => string)('cur_next')).toBe(
      '/back-office/posts?scope=open&f.title=fi&sort=title%3Aasc&cursor=cur_next',
    );
  });

  test('a sort link keeps the scope and the filters, and drops the cursor', () => {
    const props = table(
      render({ resource: filtering, request: { ...asked, cursor: 'cur_now' }, hrefFor }),
    ).props;
    const sortHrefFor = props['sortHrefFor'] as (sort?: {
      key: string;
      direction: string;
    }) => string;
    expect(sortHrefFor({ key: 'title', direction: 'desc' })).toBe(
      '/back-office/posts?scope=open&f.title=fi&sort=title%3Adesc',
    );
  });

  test('the tabs and the filter bar are handed the request, and links built from it', () => {
    const nodes = render({ resource: filtering, request: asked, hrefFor });
    const tabs = one(byComponent(nodes, 'AdminScopeTabs'), '<AdminScopeTabs>');
    // Another scope's tab keeps the filters and the sort.
    expect((tabs.props['hrefFor'] as (name: string | null) => string)('mine')).toBe(
      '/back-office/posts?scope=mine&f.title=fi&sort=title%3Aasc',
    );
    const bar = one(byComponent(nodes, 'AdminFilterBar'), '<AdminFilterBar>');
    expect(bar.props['action']).toBe('/back-office/posts');
    // Clear drops the filters and nothing else.
    expect(bar.props['clearHref']).toBe('/back-office/posts?scope=open&sort=title%3Aasc');
    expect(bar.props['request']).toBe(asked);
  });

  test('an empty page still draws the tabs and the bar — a filter that matched nothing is undone there', () => {
    const nodes = render({
      resource: filtering,
      request: asked,
      hrefFor,
      page: pageOf({ rows: [], hasMore: false, nextCursor: null }),
    });
    expect(byComponent(nodes, 'AdminFilterBar')).toHaveLength(1);
    expect(byComponent(nodes, 'DataTable')).toHaveLength(0);
  });
});

describe('the pager is prev/next cursor LINKS and nothing else', () => {
  test('the cursors and the URL builder are handed to the table — no callback', () => {
    const props = table(render({ page: pageOf({ prevCursor: 'cur_prev' }) })).props;
    expect(props['nextCursor']).toBe('cur_next');
    expect(props['prevCursor']).toBe('cur_prev');
    expect((props['hrefFor'] as (cursor: string) => string)('cur_next')).toBe(
      '/back-office/posts?cursor=cur_next',
    );
    expect(props['onCursor']).toBeUndefined();
  });

  test('next is absent at the end of the list even though a cursor exists', () => {
    // `hasMore` is the fact; a stale `nextCursor` beside it must not draw a link to nowhere.
    const props = table(render({ page: pageOf({ hasMore: false }) })).props;
    expect(props['nextCursor']).toBeUndefined();
  });

  test('previous is absent on the first page', () => {
    expect(table(render()).props['prevCursor']).toBeUndefined();
  });
});

describe('row actions', () => {
  test('a resource with no action has no action column', () => {
    expect(columnsOf(render()).map((column) => column.key)).not.toContain('actions');
  });

  test('each row gets the action bar with ITS row as the subject, posting at its own URL', () => {
    const allowAll: AdminAuthz = {
      decide: (query): AdminDecision => allowed(query.permission, 'probe.granted'),
    };
    const columns = columnsOf(render({ resource: resourceWith([publish]), authz: allowAll }));
    const column = columns.find((candidate) => candidate.key === 'actions');
    expect(column?.header).toBe('Actions (probe)');
    const row = { id: 'p_9', title: 'Ninth' };
    const bar = one(
      byComponent(shallowNodesOf(column?.cell(row)), 'AdminActions'),
      '<AdminActions>',
    );
    // The row rides the subject so a rule that reads it decides about THIS row.
    expect(bar.props['subject']).toEqual({ entity: 'post', id: 'p_9', row });
    expect(bar.props['href']).toBe('/back-office/posts/p_9');
  });
});
