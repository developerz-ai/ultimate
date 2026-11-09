/**
 * unit — the dashboard is CONSTRUCTED, mounted, granted, and what it projects is asserted: the
 * resources the entities become, the role map that opens them, and the run console's operator
 * view — the `running` / `failed` tabs, a run's events as its related rows, and `cancel` on a
 * live run only, one row or a whole selection.
 */

import { db, driver } from '@postly/db';
import { api } from '@postly/web/api';
import {
  type AdminActor,
  adminList,
  adminRouteMatch,
  invokeRowAction,
  relatedLists,
  relatedOf,
  runAdminBatch,
} from '@ultimat3/admin';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { roleDefinitions, rolesGranting } from '@ultimat3/policy';
import { afterEach, describe, expect, type RunJobs, test } from '@ultimat3/testing';
import { admin } from './admin';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OPERATOR: AdminActor = {
  id: 'owner-1',
  orgId: ORG,
  roles: ['owner'],
  locale: 'en',
  timeZone: 'UTC',
};
const READER: AdminActor = { ...OPERATOR, id: 'reader-1', roles: ['reader'] };

/** The same person as the app sees them: the actions the dashboard calls decide on this actor. */
const APP_OWNER = userActor({ id: OPERATOR.id, orgId: ORG, roles: ['owner'] });

/** The request the dashboard serves, with the operator as its actor. */
const asOperator = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: APP_OWNER }), run);

/** The resources this app declares, in the order it declares them. */
const APP_RESOURCES = [
  'orgs',
  'members',
  'posts',
  'comments',
  'connections',
  'runs',
  'run_events',
  'post_like_totals',
  'daily_likes',
];
/** The app's own catalogs: the dashboard's titles resolve there, by `admin.<entity>.title`. */
const CATALOGS = `${import.meta.dir}/../../../../packages/i18n/catalogs`;
/** Written by a job alone — a run, its events, a refreshed view, a rollup: an operator reads. */
const READ_ONLY_RESOURCES = ['runs', 'run_events', 'post_like_totals', 'daily_likes'];
const isApp = (name: string): boolean => APP_RESOURCES.includes(name);

const ctx = (actor: AdminActor = OPERATOR) => admin.ctx({ actor, requestId: 'test' });

describe('the dashboard is derived from the entities, not restated', () => {
  test('each entity is one resource, in declaration order, at its own name', () => {
    // The app's own; the framework adds its jobs screens beside them, which are not this file's.
    expect(admin.resources.map((resource) => resource.name).filter(isApp)).toEqual(APP_RESOURCES);
    const paths = admin.routes.map((route) => route.path);
    expect(paths).toContain('/admin/runs');
    expect(paths).not.toContain('/admin/orgses');
  });

  test('what a job writes is read-only: a run, its events, the like totals, the daily likes', () => {
    for (const name of READ_ONLY_RESOURCES) {
      expect([...admin.resource(name).operations].sort()).toEqual(['detail', 'list', 'search']);
    }
    const paths = admin.routes.map((route) => route.path);
    for (const name of READ_ONLY_RESOURCES) {
      expect(paths).toContain(`/admin/${name}`);
      expect(paths).not.toContain(`/admin/${name}/new`);
    }
  });

  test('every resource is titled from the catalog, in each locale', async () => {
    const lookup = (node: unknown, part: string): unknown =>
      typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined;
    for (const locale of ['en', 'es']) {
      const catalog: unknown = await Bun.file(`${CATALOGS}/${locale}.json`).json();
      const missing = APP_RESOURCES.map((name) => admin.resource(name).titleKey).filter(
        (key) => typeof key.split('.').reduce(lookup, catalog) !== 'string',
      );
      expect({ locale, missing }).toEqual({ locale, missing: [] });
    }
    expect(APP_RESOURCES.map((name) => admin.resource(name).titleKey)).toContain(
      'admin.daily_likes.title',
    );
  });

  test('each toolbar action lands on its own entity, and a run carries its cancel', () => {
    const projected = admin.resources
      .filter((resource) => isApp(resource.name))
      .map((resource) => `${resource.name}:${resource.actions.map((a) => a.name).join(',')}`);
    expect(projected).toEqual([
      'orgs:upgradePlan',
      'members:inviteMember',
      'posts:publishPost',
      'comments:',
      'connections:',
      'runs:run.cancel',
      'run_events:',
      'post_like_totals:',
      'daily_likes:',
    ]);
  });

  test('a connection’s credential and exit are never a column an operator reads', () => {
    const secret = admin.resource('connections').secretFields.map((field) => field.name);
    expect(secret.sort()).toEqual(['credential', 'exit']);
  });
});

describe('who may open it is the role map, and only the owner holds it', () => {
  const required = [
    ...new Set([
      ...admin.routes.flatMap((route) => route.permissions),
      ...admin.resources.flatMap((resource) => resource.actions.map((a) => a.permission)),
    ]),
  ];

  test('every permission the dashboard asks for is granted to the owner', () => {
    expect(required).toContain('admin:read');
    expect(required).toContain('runs:read');
    const roles = roleDefinitions();
    const ungranted = required.filter(
      (permission) => rolesGranting(permission, roles).length === 0,
    );
    expect(ungranted).toEqual([]);
    for (const permission of required) {
      expect(rolesGranting(permission, roles)).toContain('owner');
    }
  });

  test('the audit trail answers a filtered URL, and refuses one it cannot read', async () => {
    const statusOf = (path: string) =>
      asOperator(async () => {
        const url = `http://localhost${path}`;
        const matched = adminRouteMatch(admin, new URL(url).pathname);
        if (matched === null) return expect.unreachable(`no admin route serves ${path}`);
        const response = await matched.route.respond({
          ctx: await admin.requestCtx(new Request(url)),
          params: matched.params,
          url,
          method: 'GET',
          form: null,
        });
        return response.kind === 'document' ? response.status : 303;
      });
    expect(await statusOf('/admin/audit?outcome=denied&since=2026-11-01&changes=1')).toBe(200);
    expect(await statusOf('/admin/audit?org=someone-else')).toBe(400);
  });

  test('a reader opens nothing: the coarse gate is not theirs', async () => {
    const listed = await adminList(admin.resource('runs'), ctx(READER));
    expect(listed.ok).toBe(false);
  });
});

describe('the run console’s operator view', () => {
  afterEach(() => {
    driver.reset?.();
  });

  /**
   * Two live runs on two connections, and one that ended: what the tabs and the cancel read. The
   * live ones are started through the console's own action, so they are queued in the queue
   * `runJobs` installed — which is why every test here takes the fixture.
   */
  const seedRuns = (queue: RunJobs) =>
    asOperator(async () => {
      expect(await queue.depth()).toBe(0);
      const live: string[] = [];
      for (const label of ['Ledger', 'Bank']) {
        const made = await api.actions.connectSite.as(APP_OWNER, {
          orgId: ORG,
          label,
          credential: 'correct horse battery',
        });
        const run = await api.actions.startRun.as(APP_OWNER, { orgId: ORG, connectionId: made.id });
        live.push(run.runId);
      }
      const [first] = await db.connections.limit(1).all();
      const ended = await db.runs.insert({
        id: '00000000-0000-4000-8000-0000000000e9',
        orgId: ORG,
        connectionId: first?.id ?? '',
        jobId: 'job-ended',
        status: 'failed',
        code: 'X_SCRAPE_PROMPT_UNANSWERED',
      });
      return { live, ended: ended.id };
    });

  const statusOf = (id: string) =>
    asOperator(async () => (await db.runs.where({ id }).one())?.status);

  const cancelOf = () =>
    admin.resource('runs').actions[0] ?? expect.unreachable('runs declares a cancel');

  test('running and failed are tabs with counts', () => {
    const scopes = admin.resource('runs').scopes;
    expect(scopes.map((scope) => [scope.name, scope.count])).toEqual([
      ['running', true],
      ['failed', true],
    ]);
  });

  test('the failed tab lists exactly the runs that failed', async ({ runJobs }) => {
    const { ended } = await seedRuns(runJobs);
    const listed = await asOperator(() =>
      adminList(admin.resource('runs'), ctx(), { scope: 'failed' }),
    );
    if (!listed.ok) return expect.unreachable('the owner may list runs');
    expect(listed.page.rows.map((row) => row['id'])).toEqual([ended]);
  });

  test('a run’s detail lists its events as related rows', async ({ runJobs }) => {
    const { live } = await seedRuns(runJobs);
    const runId = live[0] ?? expect.unreachable('a run was started');
    await asOperator(() => api.actions.cancelRun.as(APP_OWNER, { orgId: ORG, runId }));
    const related = relatedOf(admin.resources, admin.resource('runs'));
    const lists = await asOperator(() => relatedLists(related, { id: runId }, ctx()));
    expect(lists.map((list) => list.related.name)).toEqual(['run_events']);
    expect(lists[0]?.page.rows.map((row) => [row['kind'], row['message']])).toEqual([
      ['failed', 'X_ABORTED'],
    ]);
  });

  test('cancel applies to a live run and is refused on one that ended', async ({ runJobs }) => {
    const { live, ended } = await seedRuns(runJobs);
    const runsResource = admin.resource('runs');
    const row = (id: string) =>
      asOperator(() =>
        invokeRowAction({ resource: runsResource, action: cancelOf(), id, ctx: ctx() }),
      );
    const refused = await row(ended);
    expect(refused.ok ? 'done' : refused.kind).toBe('not-applicable');
    const [first = '', second = ''] = live;
    expect((await row(first)).ok).toBe(true);
    expect([await statusOf(first), await statusOf(second)]).toEqual(['failed', 'queued']);
  });

  test('a batch cancels every live run it is handed and skips the ended one', async ({
    runJobs,
  }) => {
    const { live, ended } = await seedRuns(runJobs);
    const answer = await asOperator(() =>
      runAdminBatch({
        resource: admin.resource('runs'),
        action: cancelOf(),
        ctx: ctx(),
        selection: { kind: 'ids', ids: [...live, ended] },
      }),
    );
    if (!answer.ok) return expect.unreachable('the owner may cancel runs');
    expect([answer.done, answer.refused, answer.failed]).toEqual([2, 1, 0]);
    for (const id of live) expect(await statusOf(id)).toBe('failed');
  });
});
