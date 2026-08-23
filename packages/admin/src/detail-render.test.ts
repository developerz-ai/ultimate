// The detail screen's four states and the two things it must never do: render a sensitive column,
// or build a link by concatenation. `operationLabel` has its own file (`detail.test.ts`); this one
// drives the component.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AuditEntry } from './audit';
import { type AdminActor, type AdminAuthz, type AdminDecision, allowed, denied } from './authz';
import type { AdminField } from './fields';
import {
  byComponent,
  byTag,
  installFactory,
  nodesOf,
  one,
  renderHtml,
  restoreFactory,
  shallowNodesOf,
  withAttr,
} from './inert-jsx';
import type { AdminResource } from './resource';

/**
 * Loaded dynamically, and this is the only shape that works. `detail.tsx` contains a `<>`, and the
 * fragment factory Bun falls back to under `jsx: 'preserve'` resolves to nothing — the elements
 * render through the classic `React.createElement` shim and the FRAGMENT is a `ReferenceError`.
 * `@ultimat3/render`'s `Bun.plugin` is the real factory, and a plugin only transforms modules
 * loaded AFTER it: a static `import './detail'` is transformed while the graph is still loading,
 * before any module has evaluated. Importing render first, then the view, is what an app's
 * `server.ts` does in the same order and for the same reason.
 */
await import('@ultimat3/render/server');
const { AdminDetail } = await import('./detail');

registerCatalog('en', {
  'admin.post.title': 'Posts (probe)',
  'admin.detail.loading': 'Loading (probe)',
  'admin.detail.edit': 'Edit (probe)',
  'admin.detail.not-found.cause': 'No {entity} with that id (probe)',
  'admin.detail.not-found.fix': 'Go back (probe)',
  'admin.audit.title': 'Audit (probe)',
  'admin.audit.empty': 'Nothing logged (probe)',
  'admin.post.field.title': 'Title (probe)',
  'admin.post.field.secret': 'Secret (probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

const field = (over: Partial<AdminField>): AdminField => ({
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
  ...over,
});

const TITLE = field({});
const SECRET = field({
  name: 'secret',
  labelKey: 'admin.post.field.secret',
  sensitive: true,
});

const resource = {
  name: 'post',
  path: '/posts',
  titleKey: 'admin.post.title',
  group: 'admin.group.data',
  idField: 'id',
  labelField: 'title',
  fields: [TITLE, SECRET],
  actions: [],
} as unknown as AdminResource;

const ACTOR: AdminActor = { id: 'u_1', roles: ['editor'], orgId: 'org_1' };

/** Never asked in the states below; a call here would mean a view decided something itself. */
const refuseAll: AdminAuthz = {
  decide: (query): AdminDecision => denied(query.permission, 'probe.refused'),
};

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'a1',
  at: '2026-08-19T00:00:00.000Z',
  requestId: 'req_1',
  actor: { id: 'u_1', roles: [] },
  operation: 'update',
  kind: 'operation',
  entity: 'post',
  entityId: 'p1',
  permission: 'admin:write',
  outcome: 'allowed',
  reason: 'admin.policy.all-granted',
  diff: [],
  ...over,
});

const detail = (over: Record<string, unknown>): unknown =>
  AdminDetail({
    resource,
    row: { id: 'p_1', title: 'Hello', secret: 'hunter2' },
    loading: false,
    error: null,
    ctx: { timeZone: 'UTC', locale: 'en-US' },
    actor: ACTOR,
    authz: refuseAll,
    audit: [],
    basePath: '/back-office',
    ...over,
  } as never);

describe('the four states, in the order the component decides them', () => {
  test('an error wins over everything else, rehydrated as an UltimateError', () => {
    const nodes = shallowNodesOf(
      detail({
        error: { code: 'X_ADMIN_DENIED', cause: 'no grant', fix: 'ask an owner' },
        loading: true,
        row: null,
      }),
    );
    const state = one(byComponent(nodes, 'ErrorState'), '<ErrorState>');
    const error = state.props['error'] as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_ADMIN_DENIED');
    expect(error.cause).toBe('no grant');
    expect(error.fix).toBe('ask an owner');
  });

  test('loading is a state, announced as busy — not a blank card', () => {
    const nodes = shallowNodesOf(detail({ loading: true, row: null }));
    const busy = one(withAttr(nodes, 'aria-busy'), 'the busy paragraph');
    expect(busy.props['aria-busy']).toBe('true');
    expect(busy.props['children']).toBe('Loading (probe)');
    expect(byComponent(nodes, 'ErrorState')).toHaveLength(0);
  });

  test('no row is a not-found state naming the entity, with a way out', () => {
    const nodes = shallowNodesOf(detail({ row: null }));
    const state = one(byComponent(nodes, 'ErrorState'), '<ErrorState>');
    const error = state.props['error'] as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_ADMIN_ENTITY_UNKNOWN');
    // The interpolation, not just the key: `{entity}` is what tells the operator WHAT is missing.
    expect(error.cause).toBe('No post with that id (probe)');
    expect(error.fix).toBe('Go back (probe)');
  });

  test('a row renders the record, and none of the three failure states', () => {
    const nodes = shallowNodesOf(detail({}));
    expect(byComponent(nodes, 'ErrorState')).toHaveLength(0);
    expect(withAttr(nodes, 'aria-busy')).toHaveLength(0);
    expect(byTag(nodes, 'dl')).toHaveLength(1);
  });
});

describe('a sensitive column never reaches the page', () => {
  test('its label, its value and its key are all absent', () => {
    const html = renderHtml(detail({}));
    expect(html).toContain('Title (probe)');
    expect(html).toContain('Hello');
    // The value is the point; the label leaking would still tell a reader the column exists.
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('Secret (probe)');
  });
});

describe('the edit link is built from the route table, never by concatenation', () => {
  test('basePath, the resource path and the row id, in that order', () => {
    const nodes = shallowNodesOf(detail({}));
    const link = one(byTag(nodes, 'a'), '<a>');
    expect(link.props['href']).toBe('/back-office/posts/p_1/edit');
    expect(link.props['children']).toBe('Edit (probe)');
  });

  test('the id comes from the resource idField, not from a hardcoded "id"', () => {
    const bySlug = { ...resource, idField: 'slug' } as AdminResource;
    const nodes = shallowNodesOf(
      detail({ resource: bySlug, row: { id: 'p_1', slug: 'hello-world', title: 'Hello' } }),
    );
    expect(one(byTag(nodes, 'a'), '<a>').props['href']).toBe('/back-office/posts/hello-world/edit');
  });

  test('a row whose id field is absent still addresses something, not "undefined"', () => {
    const nodes = shallowNodesOf(detail({ row: { title: 'Hello' } }));
    expect(one(byTag(nodes, 'a'), '<a>').props['href']).toBe('/back-office/posts//edit');
  });
});

describe('the action bar is handed this row as its subject', () => {
  test('entity and id, so a row-level rule can fire on the buttons too', () => {
    const asked: string[] = [];
    const subjects: unknown[] = [];
    const authz: AdminAuthz = {
      decide(query): AdminDecision {
        asked.push(query.permission);
        subjects.push(query.subject);
        return allowed(query.permission, 'probe.granted');
      },
    };
    const withAction = {
      ...resource,
      actions: [
        {
          name: 'post.publish',
          permission: 'post:publish',
          entity: 'post',
          handle: async (): Promise<unknown> => ({}),
        },
      ],
    } as unknown as AdminResource;

    // The DEEP walk: `<AdminActions>` has to be CALLED for the gate behind it to run at all.
    nodesOf(detail({ resource: withAction, authz }));
    expect(asked).toEqual(['admin:write', 'post:publish']);
    expect(subjects).toEqual([
      { entity: 'post', id: 'p_1' },
      { entity: 'post', id: 'p_1' },
    ]);
  });
});

describe('the audit trail', () => {
  test('an empty trail says so rather than rendering an empty list', () => {
    const nodes = shallowNodesOf(detail({}));
    expect(byTag(nodes, 'ol')).toHaveLength(0);
    const empty = one(
      byTag(nodes, 'p').filter((node) => node.props['class'] === 'x-admin-empty'),
      'the empty note',
    );
    expect(empty.props['children']).toBe('Nothing logged (probe)');
  });

  test('each entry carries its instant, its actor and its outcome as data', () => {
    const nodes = shallowNodesOf(detail({ audit: [entry({ outcome: 'denied' })] }));
    expect(byTag(nodes, 'ol')).toHaveLength(1);
    expect(one(byTag(nodes, 'code'), 'the timestamp').props['children']).toBe(
      '2026-08-19T00:00:00.000Z',
    );
    // `data-outcome` is what a stylesheet keys the denied row off; the text is a catalog key.
    expect(one(withAttr(nodes, 'data-outcome'), 'the outcome').props['data-outcome']).toBe(
      'denied',
    );
  });

  test('a field diff renders before and after, with an absent side as an empty string', () => {
    const html = renderHtml(
      detail({
        audit: [
          entry({
            diff: [
              { field: 'title', before: 'Old', after: 'New' },
              { field: 'body', before: null, after: 'Added' },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain('<del>Old</del>');
    expect(html).toContain('<ins>New</ins>');
    // `String(null)` would render the word "null" into an audit row an auditor reads.
    expect(html).toContain('<del></del>');
    expect(html).toContain('<ins>Added</ins>');
  });
});
