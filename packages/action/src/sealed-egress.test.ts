// One assertion per way an `action` answers with a row of an entity that declares sealed columns:
// HTTP (bare, wrapped, a list, the record envelope), the durable `job` projection, the MCP tool,
// and an idempotent replay. `output: entity.$schema` drops the columns at the output parse; a
// LOOSE output — one that copies whatever keys the value enumerates — has no such parse to lean
// on, and still must not answer them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anonymousActor, createContext } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { toRoute } from './http';
import { memoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';
import { toJobHandle } from './job-handle';

const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';
const SEALED = /x1\.[0-9a-f]{16}\./;

const accounts = entity('ae_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    credential: text().sealed(),
    contact: text().sealed({ lookup: true }),
  },
});

const table = database({ accounts }, { driver: memoryDriver() }).accounts;
const Input = t.object({ name: t.string });

/** What a handler holds: the repository row, plaintext and all. */
const load = async () => {
  const [row] = await table.all();
  if (row === undefined) return expect.unreachable('the fixture row was not seeded');
  expect(row.credential).toBe(CANARY);
  return row;
};

const one = action({
  input: Input,
  output: accounts.$schema,
  policy: allow(),
  mcp: { expose: true },
  handle: load,
}).named('sealedOne');

const wrapped = action({
  input: Input,
  output: t.object({ account: accounts.$schema.nullable(), all: t.array(accounts.$schema) }),
  policy: allow(),
  handle: async () => ({ account: await load(), all: [...(await table.all())] }),
}).named('sealedWrapped');

/** No entity schema anywhere: every string property the value enumerates is answered. */
const loose = action({
  input: Input,
  output: t.record(t.string),
  policy: allow(),
  mcp: { expose: true },
  handle: load,
}).named('sealedLoose');

beforeAll(async () => {
  await table.insert({ name: 'Ada', credential: CANARY, contact: LOOKUP_CANARY });
});

afterAll(() => {
  clearRegistry();
});

const wire = async (target: AnyAction): Promise<string> => {
  const route = toRoute(target);
  const server = createServer({
    routes: [route],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => null },
  });
  const response = await server.fetch(
    new Request(`http://dev.test${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify({ name: 'Ada' }),
    }),
  );
  expect(response.status).toBe(200);
  return `${JSON.stringify([...response.headers.entries()])}\n${await response.text()}`;
};

const clean = (bytes: string): void => {
  expect(bytes).toContain('Ada');
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(LOOKUP_CANARY);
  expect(bytes).not.toMatch(SEALED);
  expect(bytes).not.toContain('credential');
  expect(bytes).not.toContain('contact');
};

const ctx = () => createContext({ actor: anonymousActor() });

describe('unit · a sealed column leaves through no projection of an action', () => {
  test('HTTP: output IS the entity row — `data` and `records` of the envelope', async () => {
    clean(await wire(one));
  });

  test('HTTP: the row nested, nullable and in a list', async () => {
    clean(await wire(wrapped));
  });

  test('HTTP: a loose output has no entity schema to drop it, and answers none anyway', async () => {
    clean(await wire(loose));
  });

  test('the job projection: what a queued run returns, and the step store would keep', async () => {
    clean(JSON.stringify(await toJobHandle(one).invoke({ name: 'Ada' }, ctx())));
    clean(JSON.stringify(await toJobHandle(loose).invoke({ name: 'Ada' }, ctx())));
  });

  // `surface: 'mcp'` is the call `@ultimat3/mcp`'s one projection makes (`projectable.ts`).
  test('the MCP tool: what `tools/call` serialises', async () => {
    for (const target of [one, loose]) {
      clean(JSON.stringify(await invoke(target, { name: 'Ada' }, { ctx: ctx(), surface: 'mcp' })));
    }
  });

  test('an idempotent replay: the stored answer, and the answer served from it', async () => {
    const replayable = action({
      input: Input,
      output: t.record(t.string),
      policy: allow(),
      idempotent: true,
      handle: load,
    }).named('sealedReplay');
    const store = memoryIdempotencyStore();
    const options = { ctx: ctx(), store, idempotencyKey: 'key-1' };
    const first = await invoke(replayable, { name: 'Ada' }, options);
    let replayed = false;
    const second = await invoke(
      replayable,
      { name: 'Ada' },
      { ...options, onReplay: () => (replayed = true) },
    );
    expect(replayed).toBe(true);
    clean(JSON.stringify(first));
    clean(JSON.stringify(second));
  });
});
