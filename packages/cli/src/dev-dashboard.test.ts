// What the CLI owes the `/_x` dashboard: the three hooks no registry can answer, the two panels
// that describe this process, and a route per panel. The bug these pin is the one the mount
// replaced — a CLI that re-implemented four JSON endpoints of its own next to the real ones.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DevPanel } from '@ultimat3/admin/dev';
import { DEV_PANELS, panelPayload, staticDevSources, timelinePanel } from '@ultimat3/admin/dev';
import type { MailMessage, SendResult, SentMail } from '@ultimat3/mail';
import { appManifest, writeAppManifest } from './app-manifest';
import type { DevDashboardInput, DevStatus } from './dev-dashboard';
import { devDashboardRoutes, devPanels, devSources } from './dev-dashboard';
import type { RunningServices } from './dev-runtime';
import type { DevServices, ServiceBinding } from './dev-services';

/** The nine panels `@ultimat3/admin` ships. Spelled out so a silent drop is a failure here. */
const FRAMEWORK_PANELS = [
  'routes',
  'timeline',
  'live',
  'jobs',
  'db',
  'mail',
  'cache',
  'policy',
  'manifest',
] as const;

const binding = (name: ServiceBinding['name'], url: string): ServiceBinding => ({
  name,
  mode: 'embedded',
  url,
  detail: 'fixture',
});

const SERVICES: DevServices = {
  db: binding('db', 'pglite:///tmp/pgdata'),
  events: binding('events', 'inproc://events'),
  storage: binding('storage', 'file:///tmp/storage'),
  stateDir: '/tmp/state',
};

const STATUS: DevStatus = {
  url: 'http://localhost:3000',
  services: SERVICES,
  roles: ['web', 'worker'],
  findings: [],
  reloads: 0,
};

interface FakeRuntime {
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly outbox?: readonly SentMail[];
  /** Every statement the dashboard sent, so a test can prove it was not rewritten. */
  readonly seen?: string[];
}

/** Only the two members the hooks touch; a PGlite boot proves nothing about the projection. */
const fakeRuntime = (fake: FakeRuntime = {}): RunningServices =>
  ({
    db: {
      query: (fragment: { text: string }): Promise<readonly unknown[]> => {
        fake.seen?.push(fragment.text);
        return Promise.resolve(fake.rows ?? []);
      },
    },
    mail: { outbox: (): readonly SentMail[] => fake.outbox ?? [] },
  }) as unknown as RunningServices;

const inputFor = (
  fake: FakeRuntime = {},
  extra: { root?: string; status?: () => DevStatus } = {},
): DevDashboardInput => ({
  root: extra.root ?? '/tmp/nonexistent-app',
  runtime: fakeRuntime(fake),
  status: extra.status ?? ((): DevStatus => STATUS),
  // Explicit, so the mount guard reads the fixture's environment and not the test runner's.
  env: 'development',
});

const panelFor = (input: DevDashboardInput, key: string): DevPanel => {
  const panel = devPanels(input).find((candidate) => candidate.key === key);
  if (panel === undefined) throw new Error(`no /_x panel named "${key}"`);
  return panel;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  mailId: 'welcome',
  to: ['ada@x.test', 'grace@x.test'],
  subject: 'Welcome',
  html: '<p>hi</p>',
  text: 'hi',
  locale: 'de-DE',
  tz: 'Europe/Berlin',
  ...overrides,
});

const sendResult = (id: string): SendResult => ({
  id,
  driver: 'memory',
  accepted: ['ada@x.test'],
  queued: false,
  idempotencyKey: id,
});

const withTempApp = async (name: string, run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-dev-dashboard-'));
  try {
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name, version: '2.0.0' }));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · x dev mounts the dashboard', () => {
  test('all nine framework panels are mounted, plus the two only this process can answer', () => {
    const keys = devPanels(inputFor()).map((panel) => panel.key);
    expect(keys).toHaveLength(11);
    expect(keys).toEqual([...DEV_PANELS.map((panel) => panel.key), 'services', 'boundaries']);
    for (const key of FRAMEWORK_PANELS) expect(keys).toContain(key);
  });

  test('one route per panel plus the base path, each with its own meta.name', () => {
    const input = inputFor();
    const routes = devDashboardRoutes(input);
    const keys = devPanels(input).map((panel) => panel.key);

    expect(routes.map((route) => route.path)).toEqual(['/_x', ...keys.map((key) => `/_x/${key}`)]);
    const names = routes.map((route) => route.meta.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('dev._x');
    expect(names).toContain('dev._x.services');
    expect(routes.every((route) => route.method === 'GET')).toBe(true);
    expect(routes.every((route) => route.meta.auth === 'public')).toBe(true);
  });

  test('the services panel reads status per request, so a reload shows up without a remount', async () => {
    let reloads = 0;
    const panel = panelFor(
      inputFor({}, { status: (): DevStatus => ({ ...STATUS, reloads }) }),
      'services',
    );
    // `staticDevSources()` is passed and must be ignored: these are process facts, not
    // introspection — a panel that consulted the sources here would answer for the wrong process.
    const before = asRecord(await panel.data(staticDevSources(), new URLSearchParams()));
    reloads = 3;
    const after = asRecord(await panel.data(staticDevSources(), new URLSearchParams()));

    expect(before['reloads']).toBe(0);
    expect(after['reloads']).toBe(3);
    expect(after['roles']).toEqual(['web', 'worker']);
    expect(after['stateDir']).toBe('/tmp/state');
  });

  test('runSql projects rows into columns and tuples, and times the round trip', async () => {
    const seen: string[] = [];
    const sources = devSources(
      inputFor({
        seen,
        rows: [
          { n: 1, label: 'one' },
          { n: 2, label: 'two' },
        ],
      }),
    );
    const result = await sources.runSql('select n, label from t');

    // Verbatim: `assertReadOnly` in `dbPanel` is the only gate, so the CLI must not rewrite SQL.
    expect(seen).toEqual(['select n, label from t']);
    expect(result.columns).toEqual(['n', 'label']);
    expect(result.rows).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('an empty result names no columns rather than guessing a header', async () => {
    const result = await devSources(inputFor({ rows: [] })).runSql('select 1 where false');
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test('the mail hook maps the caught outbox onto MailFacts', async () => {
    const at = new Date('2026-08-09T10:11:12.000Z');
    const outbox: readonly SentMail[] = [{ at, message: message(), result: sendResult('mem_abc') }];
    expect(await devSources(inputFor({ outbox })).mail()).toEqual([
      {
        id: 'mem_abc',
        to: 'ada@x.test, grace@x.test',
        subject: 'Welcome',
        locale: 'de-DE',
        html: '<p>hi</p>',
        text: 'hi',
        sentAt: '2026-08-09T10:11:12.000Z',
      },
    ]);
  });

  test('an unwired source answers with the wiring line instead of throwing out of the panel', async () => {
    const payload = await panelPayload(
      timelinePanel,
      devSources(inputFor()),
      new URLSearchParams(),
    );
    expect(payload.ok).toBe(false);
    const error = payload.ok ? undefined : payload.error;
    expect(error?.code).toBe('X_NOT_IMPLEMENTED');
    // The fix line names the exact hook to supply — an empty array would say "nothing happened".
    expect(error?.fix).toContain('traces');
  });

  test('a manifest that was never generated is all-added, with the committed side undefined', async () => {
    await withTempApp('never-generated', async (root) => {
      const fact = await devSources(inputFor({}, { root })).manifest();
      expect(fact.committed).toBeNull();
      expect(fact.diff.length).toBeGreaterThan(0);
      expect(fact.diff.every((entry) => entry.committed === undefined)).toBe(true);
      expect(fact.diff.map((entry) => entry.path)).toContain('app');
    });
  });

  test('a committed manifest that matches has no diff; one that differs names the key', async () => {
    await withTempApp('dash-fixture', async (root) => {
      const input = inputFor({}, { root });
      const emitted = (await appManifest(root)).manifest;

      await writeAppManifest(root, emitted);
      expect((await devSources(input).manifest()).diff).toEqual([]);

      await writeAppManifest(root, { ...emitted, app: { name: 'dash-fixture', version: '9.9.9' } });
      const drifted = await devSources(input).manifest();
      const app = drifted.diff.find((entry) => entry.path === 'app');
      expect(app?.emitted).toEqual({ name: 'dash-fixture', version: '2.0.0' });
      expect(app?.committed).toEqual({ name: 'dash-fixture', version: '9.9.9' });
    });
  });
});
