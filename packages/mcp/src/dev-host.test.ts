// dev-host.ts is the ONE place that reaches into the primitive registries, so what is worth
// pinning here is the wiring: each description function must read its own registry, and a
// mis-wire (queries reading the action registry) is invisible in an app whose two registries
// happen to hold the same names.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { frameworkVersion } from '@ultimat3/core';
import { entity, text, uuid } from '@ultimat3/entity';
import type { JobDriver, JobIntrospection } from '@ultimat3/jobs';
import { job, jobDriver, resetJobDriver, resetJobs, setJobDriver } from '@ultimat3/jobs';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { createDevServer, devHost, frameworkIntrospection } from './dev-host';
import type { DevCapabilities } from './dev-server';
import { DEV_SCOPES } from './dev-server';
import type { McpCaller } from './registry';
import { RESOURCE_URIS } from './resources';

// Registered once, never cleared: `clearRegistry()` would drop every entity the rest of the run
// registered, and this fixture only has to be findable by name.
entity('dev_host_fixture', { columns: { id: uuid().primaryKey(), title: text({ max: 40 }) } });

const ROUTES = [{ url: '/', render: 'static' }] as const;
const POLICIES = [{ permission: 'post:publish' }] as const;

const intro = () => frameworkIntrospection({ routes: () => ROUTES, policies: () => POLICIES });

const names = (rows: unknown): readonly string[] =>
  (rows as readonly { readonly name: string }[]).map((row) => row.name);

const caller: McpCaller = {
  actor: { kind: 'agent', id: 'a1' } as unknown as Actor,
  scopes: new Set([DEV_SCOPES.read]),
};

/**
 * The one method `jobInspect` genuinely reaches. Everything else throws rather than pretending:
 * a driver that quietly answers `undefined` for `claim` would let a broken delegation pass.
 */
function recordingDriver(): { driver: JobDriver; asked: string[] } {
  const asked: string[] = [];
  const introspect = {
    async job(jobId: string) {
      asked.push(jobId);
      return undefined;
    },
    list: () => Promise.reject(new Error('list is not part of this fixture')),
    deadLetters: () => Promise.reject(new Error('deadLetters is not part of this fixture')),
    requeue: () => Promise.reject(new Error('requeue is not part of this fixture')),
  } as unknown as JobIntrospection;
  const refuse = (method: string) => () => {
    throw new Error(`the dev-host fixture driver cannot run ${method}`);
  };
  const driver = {
    name: 'dev-host-fixture',
    steps: { list: refuse('steps.list') },
    enqueue: refuse('enqueue'),
    claim: refuse('claim'),
    ack: refuse('ack'),
    nack: refuse('nack'),
    heartbeat: refuse('heartbeat'),
    stats: refuse('stats'),
    introspect,
  } as unknown as JobDriver;
  return { driver, asked };
}

describe('frameworkIntrospection', () => {
  beforeEach(() => {
    definePermissions(['post:publish', 'post:read']);
    defineRoles({ owner: { grants: ['post:publish', 'post:read'] } });
    registerAction(
      'devHostAction',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('post:publish'),
        handle: () => ({ ok: true }),
      }),
    );
    registerQuery(
      'devHostQuery',
      query({
        input: t.object({}),
        policy: can('post:read'),
        sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
      }),
    );
    job({
      tenant: 'none',
      name: 'devHostJob',
      input: t.object({ orgId: t.string }),
      idempotencyKey: ({ orgId }) => `dev-host:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
  });

  afterEach(() => {
    resetActions();
    resetQueries();
    resetJobs();
    clearPermissions();
    clearRoles();
  });

  test('routes and policies are the caller’s, because neither lives in a tier this may import', () => {
    const host = intro();
    expect(host.routes()).toBe(ROUTES);
    expect(host.policies()).toBe(POLICIES);
  });

  test('actions and queries each read their own registry, never each other’s', () => {
    const host = intro();
    expect(names(host.actions())).toContain('devHostAction');
    expect(names(host.actions())).not.toContain('devHostQuery');
    expect(names(host.queries())).toContain('devHostQuery');
    expect(names(host.queries())).not.toContain('devHostAction');
  });

  test('entities and jobs each read their own registry', () => {
    const host = intro();
    expect(names(host.entities())).toContain('dev_host_fixture');
    expect(names(host.entities())).not.toContain('devHostJob');
    expect(names(host.jobs())).toContain('devHostJob');
    expect(names(host.jobs())).not.toContain('dev_host_fixture');
  });
});

describe('frameworkIntrospection.jobInspect', () => {
  let previous: JobDriver | undefined;

  beforeEach(() => {
    previous = jobDriver();
  });

  afterEach(() => {
    if (previous === undefined) resetJobDriver();
    else setJobDriver(previous);
  });

  test('reports a missing driver as an answer, so x mcp stays usable without a queue', () => {
    resetJobDriver();
    expect(intro().jobInspect('anything')).toEqual({ error: 'no job driver configured' });
  });

  test('passes the requested name through to the ambient driver once one is configured', async () => {
    const { driver, asked } = recordingDriver();
    setJobDriver(driver);
    const answer = await intro().jobInspect('job-42');
    expect(asked).toEqual(['job-42']);
    expect(answer).toBeUndefined();
  });
});

describe('createDevServer', () => {
  test('announces itself as ultimate-dev at the framework version', async () => {
    const server = createDevServer({ host: devHost(intro(), capabilities().host) });
    const response = await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { actor: caller.actor, scopes: new Set() },
    );
    const result = response?.result as
      | { serverInfo: { name: string; version: string } }
      | undefined;
    expect(result?.serverInfo).toEqual({ name: 'ultimate-dev', version: frameworkVersion() });
  });

  test('serves the whole dev tool catalog, and only the mutating ones are writes', () => {
    const server = createDevServer({ host: devHost(intro(), capabilities().host) });
    expect(server.list(caller).map((tool) => tool.name)).toEqual([
      'actions.describe',
      'db.migrate',
      'db.query',
      'errors.explain',
      'jobs.inspect',
      'logs.tail',
      'manifest.read',
      'policies.list',
      'queue.depth',
      'routes.list',
      'schema.describe',
      'tests.run',
      'verify.run',
    ]);
    expect(server.tools.verbClass('db.migrate')).toBe('write');
    expect(server.tools.verbClass('routes.list')).toBe('read');
  });

  test('resources are opt-in: none by default, and only the ones a provider was given for', () => {
    const bare = createDevServer({ host: devHost(intro(), capabilities().host) });
    expect(bare.resources.list(caller)).toEqual([]);

    const wired = createDevServer({
      host: devHost(intro(), capabilities().host),
      resources: { manifest: () => '{"version":1}' },
    });
    expect(wired.resources.list(caller).map((resource) => resource.uri)).toEqual([
      RESOURCE_URIS.manifest,
    ]);
  });
});

describe('devHost', () => {
  test('merges the description half and the capability half into one object', async () => {
    const { host: capability, ran } = capabilities();
    const merged = devHost(intro(), capability);
    expect(merged.routes()).toBe(ROUTES);
    expect(await merged.readManifest()).toBe('{"version":1}');
    expect(ran).toEqual(['readManifest']);
  });
});

/** The shell half a real CLI supplies. Only `readManifest` is exercised; the rest refuse. */
function capabilities(): { host: DevCapabilities; ran: string[] } {
  const ran: string[] = [];
  const refuse = (method: string) => () => {
    throw new Error(`the dev-host fixture capability set cannot run ${method}`);
  };
  const host = {
    database: { label: 'app_branch_x', branch: 'x', production: false },
    runQuery: refuse('runQuery'),
    runMigrations: refuse('runMigrations'),
    queueDepth: refuse('queueDepth'),
    runTests: refuse('runTests'),
    tailLogs: refuse('tailLogs'),
    async readManifest() {
      ran.push('readManifest');
      return '{"version":1}';
    },
    explainError: refuse('explainError'),
    verify: refuse('verify'),
  } as unknown as DevCapabilities;
  return { host, ran };
}
