// `defineApi` is the app's whole boot: one call decides what registered, and its return value is
// the type the RPC client is shaped from. A drop, a silent overwrite or an unregistered export
// slipping into the map would all ship as a client method the server never mounts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type ModuleRegistrar,
  type PrimitiveKind,
  type RegisteredPrimitive,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { defineApi } from './define-api';
import { getAction, resetRegistry } from './registry';

const echo = () =>
  action({
    input: t.object({ id: t.uuid }),
    output: t.object({ id: t.uuid }),
    policy: can('post:publish'),
    handle: ({ input }) => ({ id: input.id }),
  });

/** A query, a job and a task, as far as the registrar seam can see one. */
const fakeQuery = () => ({ kind: 'query' as const, name: '' });
const fakeJob = () => ({ kind: 'job' as const, name: '' });
const fakeTask = () => ({ kind: 'task' as const, name: '' });

/**
 * Stands in for the owning package's registrar — action cannot import `@ultimat3/query` or
 * `@ultimat3/jobs` sideways. Like the real ones it takes only the branded exports and hands
 * back what it took, named.
 */
function recordingRegistrar(kind: PrimitiveKind): { seen: string[]; registrar: ModuleRegistrar } {
  const seen: string[] = [];
  return {
    seen,
    registrar: (module) => {
      const registered: RegisteredPrimitive[] = [];
      for (const name of Object.keys(module).sort()) {
        if ((module[name] as { kind?: unknown } | undefined)?.kind !== kind) continue;
        seen.push(name);
        registered.push({ kind, name });
      }
      return registered;
    },
  };
}

const recordingQueryRegistrar = (): { seen: string[]; registrar: ModuleRegistrar } =>
  recordingRegistrar('query');

beforeEach(() => {
  resetRegistry();
  resetPrimitiveRegistrars();
});

afterEach(() => {
  resetRegistry();
  resetPrimitiveRegistrars();
});

describe('defineApi', () => {
  test('registers every action module under its export names', () => {
    defineApi({ actions: [{ createPost: echo() }, { inviteMember: echo() }] });

    expect(getAction('createPost')?.name).toBe('createPost');
    expect(getAction('inviteMember')?.name).toBe('inviteMember');
  });

  test('accepts a single module as well as a list', () => {
    defineApi({ actions: { createPost: echo() } });

    expect(getAction('createPost')).toBeDefined();
  });

  test('mutators and llm land in the action registry — they are the same primitive', () => {
    defineApi({ mutators: { likePost: echo() }, llm: { summarizePost: echo() } });

    expect(getAction('likePost')).toBeDefined();
    expect(getAction('summarizePost')).toBeDefined();
  });

  test('the returned actions map holds the registered objects, not copies', () => {
    const createPost = echo();
    const api = defineApi({ actions: { createPost } });

    expect(api.actions.createPost).toBe(getAction('createPost'));
    expect(api.actions.createPost.name).toBe('createPost');
  });

  test('a primitive exported as __proto__ is a key of the map, not its prototype', () => {
    // `map['__proto__'] = value` on a plain object runs the PROTOTYPE SETTER, so the primitive
    // registered fine and then vanished from Object.keys, from api.queries and from rpc() —
    // present to the registrar and absent from every surface that reads the map back.
    const { registrar } = recordingQueryRegistrar();
    registerPrimitiveRegistrar('query', registrar);

    const api = defineApi({ queries: [{ ['__proto__']: fakeQuery() }] });

    // Read through a descriptor, not `api.queries['__proto__']`: the member access is the very
    // accessor this test exists to prove is not in play, and Biome refuses it (`noProto`).
    expect(Object.keys(api.queries)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(api.queries, '__proto__')?.value).toBeDefined();
  });

  test('two features exporting one name collide with X_ACTION_DUPLICATE', () => {
    let code = '';
    try {
      defineApi({ actions: [{ createPost: echo() }, { createPost: echo() }] });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_ACTION_DUPLICATE');
  });

  test('queries route through core registrar table, not a sideways import', () => {
    const { seen, registrar } = recordingQueryRegistrar();
    registerPrimitiveRegistrar('query', registrar);

    const api = defineApi({ queries: [{ liveFeed: fakeQuery() }, { postById: fakeQuery() }] });

    expect(seen).toEqual(['liveFeed', 'postById']);
    expect(Object.keys(api.queries)).toEqual(['liveFeed', 'postById']);
  });

  test('queries with no registrar loaded fail loudly instead of being dropped', () => {
    let code = '';
    try {
      defineApi({ queries: { liveFeed: fakeQuery() } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_REGISTRAR_MISSING');
  });

  test('no queries means the query registrar is never demanded', () => {
    expect(() => defineApi({ actions: { createPost: echo() } })).not.toThrow();
  });

  test('an empty definition registers nothing and returns empty maps', () => {
    const api = defineApi({});

    expect(Object.keys(api.actions)).toEqual([]);
    expect(Object.keys(api.queries)).toEqual([]);
    expect(Object.keys(api.jobs)).toEqual([]);
    expect(Object.keys(api.tasks)).toEqual([]);
  });

  test('jobs and tasks route through the registrar table, keyed by export name', () => {
    const jobs = recordingRegistrar('job');
    const tasks = recordingRegistrar('task');
    registerPrimitiveRegistrar('job', jobs.registrar);
    registerPrimitiveRegistrar('task', tasks.registrar);

    const api = defineApi({
      jobs: [{ sendInvite: fakeJob() }, { onboardOrg: fakeJob() }],
      tasks: { nightlyDigest: fakeTask() },
    });

    expect(jobs.seen).toEqual(['sendInvite', 'onboardOrg']);
    expect(tasks.seen).toEqual(['nightlyDigest']);
    // The whole point: without this, every one of them registers as `anonymous-job-<n>`.
    expect(Object.keys(api.jobs)).toEqual(['sendInvite', 'onboardOrg']);
    expect(Object.keys(api.tasks)).toEqual(['nightlyDigest']);
  });

  test('jobs with no registrar loaded fail loudly instead of being dropped', () => {
    let code = '';
    try {
      defineApi({ jobs: { sendInvite: fakeJob() } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_REGISTRAR_MISSING');
  });

  test('tasks with no registrar loaded fail loudly instead of being dropped', () => {
    let code = '';
    try {
      defineApi({ tasks: { nightlyDigest: fakeTask() } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_REGISTRAR_MISSING');
  });

  test('no jobs and no tasks means neither registrar is ever demanded', () => {
    expect(() => defineApi({ actions: { createPost: echo() } })).not.toThrow();
  });

  test('jobs register before tasks — a task descriptor reads the queue keys jobs just took', () => {
    const order: string[] = [];
    registerPrimitiveRegistrar('job', () => {
      order.push('job');
      return [];
    });
    registerPrimitiveRegistrar('task', () => {
      order.push('task');
      return [];
    });

    defineApi({ tasks: { nightlyDigest: fakeTask() }, jobs: { sendDigest: fakeJob() } });

    expect(order).toEqual(['job', 'task']);
  });

  test('a helper exported next to a job never reaches api.jobs', () => {
    const { registrar } = recordingRegistrar('job');
    registerPrimitiveRegistrar('job', registrar);

    const api = defineApi({ jobs: { sendInvite: fakeJob(), inviteKey: (id: string) => id } });

    expect(Object.keys(api.jobs)).toEqual(['sendInvite']);
    expect(api.jobs).not.toHaveProperty('inviteKey');
  });

  test('a module helper never reaches the API — the map is what registered, not what exported', () => {
    const helper = (id: string): string => id;
    const { registrar } = recordingQueryRegistrar();
    registerPrimitiveRegistrar('query', registrar);

    const api = defineApi({
      actions: { createPost: echo(), slugFor: helper },
      queries: { liveFeed: fakeQuery(), feedKey: helper },
    });

    expect(Object.keys(api.actions)).toEqual(['createPost']);
    expect(Object.keys(api.queries)).toEqual(['liveFeed']);
    // The clients this shapes would otherwise offer `slugFor` as a method nothing serves.
    expect(api.actions).not.toHaveProperty('slugFor');
    expect(api.queries).not.toHaveProperty('feedKey');
  });

  test('two modules exporting one helper name cannot overwrite each other in silence', () => {
    // Same name, no collision to raise — because neither is a primitive, so neither registers.
    const api = defineApi({
      actions: [
        { createPost: echo(), toRow: () => 'a' },
        { inviteMember: echo(), toRow: () => 'b' },
      ],
    });

    expect(Object.keys(api.actions).sort()).toEqual(['createPost', 'inviteMember']);
  });

  test('the returned surface is frozen — the API is declared once, not mutated later', () => {
    const api = defineApi({ actions: { createPost: echo() } });

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.actions)).toBe(true);
  });
});
