// The list screen. Three states a table actually has, and the two navigation rules the admin is
// built on: a row opens through a REAL `<a href>` (so a middle-click, a keyboard and a crawler
// all work), and paging is prev/next cursors with no page number — because there is no offset.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import { type AdminActor, type AdminAuthz, type AdminDecision, allowed, denied } from './authz';
import type { AdminField } from './fields';
import {
  byComponent,
  byTag,
  fire,
  installFactory,
  one,
  renderShallowNodes,
  restoreFactory,
  shallowNodesOf,
  withAttr,
} from './inert-jsx';
import type { AdminPage } from './pagination';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';

// Loaded after `@ultimat3/render` installs its `Bun.plugin`, for the reason
// `detail-render.test.ts` states — a plugin only transforms modules loaded after it.
await import('@ultimat3/render');
const { AdminList } = await import('./list');

registerCatalog('en', {
  'admin.post.title': 'Posts (probe)',
  'admin.list.loading': 'Loading (probe)',
  'admin.list.empty': 'No rows (probe)',
  'admin.list.open': 'Open (probe)',
  'admin.list.previous': 'Previous (probe)',
  'admin.list.next': 'Next (probe)',
  'admin.list.pagination': 'Pages (probe)',
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

const resource = {
  name: 'post',
  path: '/posts',
  titleKey: 'admin.post.title',
  idField: 'id',
  listFields: [titleField],
  actions: [],
} as unknown as AdminResource;

const ACTOR: AdminActor = { id: 'u_1', roles: ['viewer'], orgId: 'org_1' };
const refuseAll: AdminAuthz = {
  decide: (query): AdminDecision => denied(query.permission, 'probe.refused'),
};

const pageOf = (over: Partial<AdminPage<AdminRow>> = {}): AdminPage<AdminRow> =>
  ({
    rows: [{ id: 'p_1', title: 'First' }],
    sort: { field: 'id', direction: 'desc' },
    nextCursor: 'cur_next',
    prevCursor: null,
    hasMore: true,
    ...over,
  }) as AdminPage<AdminRow>;

interface Rendered {
  readonly nodes: ReturnType<typeof shallowNodesOf>;
  readonly cursors: (string | null)[];
  readonly opened: string[];
  readonly sorts: unknown[];
}

function render(over: Record<string, unknown> = {}): Rendered {
  const cursors: (string | null)[] = [];
  const opened: string[] = [];
  const sorts: unknown[] = [];
  const nodes = renderShallowNodes(AdminList, {
    resource,
    page: pageOf(),
    loading: false,
    error: null,
    ctx: { timeZone: 'UTC', locale: 'en-US' },
    actor: ACTOR,
    authz: refuseAll,
    basePath: '/back-office',
    onCursor: (cursor: string | null) => cursors.push(cursor),
    onOpen: (id: string) => opened.push(id),
    onSort: (sort: unknown) => sorts.push(sort),
    ...over,
  });
  return { nodes, cursors, opened, sorts };
}

const table = (rendered: Rendered): ReturnType<typeof one> =>
  one(byComponent(rendered.nodes, 'DataTable'), '<DataTable>');

interface Column {
  readonly key: string;
  readonly header: string;
  readonly sortable?: boolean;
  cell(row: AdminRow): unknown;
}

const columnsOf = (rendered: Rendered): readonly Column[] =>
  table(rendered).props['columns'] as readonly Column[];

describe('the three states', () => {
  test('an error wins over loading and over the page', () => {
    // The state precedence, exercised with all three set at once.
    const nodes = renderShallowNodes(AdminList, {
      resource,
      page: pageOf(),
      loading: true,
      error: { code: 'X_ADMIN_DENIED', cause: 'no grant', fix: 'ask an owner' },
      ctx: { timeZone: 'UTC', locale: 'en-US' },
      actor: ACTOR,
      authz: refuseAll,
      basePath: '/back-office',
      onCursor: () => undefined,
      onOpen: () => undefined,
    });
    const state = one(byComponent(nodes, 'ErrorState'), '<ErrorState>');
    expect((state.props['error'] as { code: string }).code).toBe('X_ADMIN_DENIED');
  });

  test('loading is announced as busy', () => {
    const rendered = render({ loading: true });
    expect(one(withAttr(rendered.nodes, 'aria-busy'), 'the busy note').props['children']).toBe(
      'Loading (probe)',
    );
  });

  test('a NULL page is the loading state too — a table with no page is not an empty table', () => {
    const rendered = render({ page: null, loading: false });
    expect(withAttr(rendered.nodes, 'aria-busy')).toHaveLength(1);
    expect(byComponent(rendered.nodes, 'DataTable')).toHaveLength(0);
  });

  test('a page with no rows says so instead of rendering an empty grid', () => {
    const rendered = render({ page: pageOf({ rows: [] }) });
    expect(byComponent(rendered.nodes, 'DataTable')).toHaveLength(0);
    const empty = one(
      byTag(rendered.nodes, 'p').filter((node) => node.props['class'] === 'x-admin-empty'),
      'the empty note',
    );
    expect(empty.props['children']).toBe('No rows (probe)');
    // The pager still renders: an empty page can still have a previous one.
    expect(byTag(rendered.nodes, 'nav')).toHaveLength(1);
  });
});

describe('a row opens through a real link', () => {
  test('the href is basePath + resource path + the row id', () => {
    const cell = columnsOf(render())[0];
    expect(cell?.key).toBe('open');
    expect(cell?.header).toBe('Open (probe)');

    const link = one(shallowNodesOf(cell?.cell({ id: 'p_1', title: 'First' })), '<a>');
    // A row-click handler alone would not survive a middle-click, a keyboard or a crawler.
    expect(link.props['href']).toBe('/back-office/posts/p_1');
    expect(link.props['children']).toBe('p_1');
  });

  test('clicking it is intercepted for the SPA rather than reloading the document', () => {
    const rendered = render();
    const link = one(shallowNodesOf(columnsOf(rendered)[0]?.cell({ id: 'p_9' })), '<a>');

    const prevented: number[] = [];
    fire(link, 'onClick', { preventDefault: () => prevented.push(1) });
    expect(prevented).toEqual([1]);
    expect(rendered.opened).toEqual(['p_9']);
  });

  test('the id comes from the resource idField, through rowId', () => {
    const bySlug = { ...resource, idField: 'slug' } as AdminResource;
    const rendered = render({ resource: bySlug });
    const link = one(
      shallowNodesOf(columnsOf(rendered)[0]?.cell({ id: 'p_1', slug: 'hello' })),
      '<a>',
    );
    expect(link.props['href']).toBe('/back-office/posts/hello');
  });
});

describe('the derived columns', () => {
  test('one column per list field, labelled by its own key, rendering through the widget', () => {
    const columns = columnsOf(render());
    expect(columns.map((column) => column.key)).toEqual(['open', 'title']);
    expect(columns[1]?.header).toBe('Title (probe)');

    const cell = shallowNodesOf(columns[1]?.cell({ id: 'p_1', title: 'First' }));
    const widget = one(byComponent(cell, 'Widget'), '<Widget>');
    expect(widget.props['value']).toBe('First');
    // Read mode: a list cell is never an input.
    expect(widget.props['mode']).toBe('read');
  });

  test('a sortable column is only sortable when the route accepts a sort', () => {
    expect(columnsOf(render())[1]?.sortable).toBe(true);
    // No `onSort`: the table renders its current order and offers no header a click does nothing on.
    expect(columnsOf(render({ onSort: undefined }))[1]?.sortable).toBe(false);
  });

  test('the current sort is handed to the table, and a change is reported back', () => {
    const rendered = render();
    expect(table(rendered).props['sort']).toEqual({ key: 'id', direction: 'desc' });

    fire(table(rendered), 'onSortChange', { key: 'title', direction: 'asc' });
    expect(rendered.sorts).toEqual([{ field: 'title', direction: 'asc' }]);
  });

  test('clearing the sort reports nothing rather than a sort on undefined', () => {
    const rendered = render();
    fire(table(rendered), 'onSortChange', undefined);
    expect(rendered.sorts).toEqual([]);
  });
});

describe('the pager is prev/next cursors and nothing else', () => {
  const pagerButtons = (rendered: Rendered): ReturnType<typeof byTag> =>
    byTag(rendered.nodes, 'button');

  test('previous is disabled on the first page, next is enabled while there is more', () => {
    const rendered = render();
    const [previous, next] = pagerButtons(rendered);
    expect(previous?.props['disabled']).toBe(true);
    expect(next?.props['disabled']).toBe(false);
    expect(previous?.props['children']).toBe('Previous (probe)');
    expect(next?.props['children']).toBe('Next (probe)');
  });

  test('next is disabled at the end of the list even though a cursor exists', () => {
    // `hasMore`, not `nextCursor !== null`: a keyset page always has a bound for its last row.
    const rendered = render({ page: pageOf({ hasMore: false, nextCursor: 'cur_last' }) });
    expect(pagerButtons(rendered)[1]?.props['disabled']).toBe(true);
  });

  test('pressing next reports the page’s own next cursor', () => {
    const rendered = render();
    fire(pagerButtons(rendered)[1] as never, 'onClick', {});
    expect(rendered.cursors).toEqual(['cur_next']);
  });

  test('pressing previous reports the previous cursor, not null', () => {
    const rendered = render({ page: pageOf({ prevCursor: 'cur_prev' }) });
    fire(pagerButtons(rendered)[0] as never, 'onClick', {});
    expect(rendered.cursors).toEqual(['cur_prev']);
  });

  test('the pager is a labelled landmark, and carries no page number', () => {
    const rendered = render();
    const nav = one(byTag(rendered.nodes, 'nav'), '<nav>');
    expect(nav.props['aria-label']).toBe('Pages (probe)');
    expect(pagerButtons(rendered)).toHaveLength(2);
  });
});

describe('the action bar', () => {
  test('it is scoped to the TABLE, with no row id — a list action is not a row action', () => {
    const asked: unknown[] = [];
    const authz: AdminAuthz = {
      decide(query): AdminDecision {
        asked.push(query.subject);
        return allowed(query.permission, 'probe.granted');
      },
    };
    const withAction = {
      ...resource,
      actions: [
        {
          name: 'post.reindex',
          permission: 'post:publish',
          entity: 'post',
          handle: async (): Promise<unknown> => ({}),
        },
      ],
    } as unknown as AdminResource;

    const rendered = render({ resource: withAction, authz });
    const bar = one(byComponent(rendered.nodes, 'AdminActions'), '<AdminActions>');
    expect(bar.props['subject']).toEqual({ entity: 'post' });

    // Running one resets to page one: the rows it changed may not be on this page any more.
    fire(bar, 'onRun', {});
    expect(rendered.cursors).toEqual([null]);
    expect(asked).toEqual([]);
  });
});
