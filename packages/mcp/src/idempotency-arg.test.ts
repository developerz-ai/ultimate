// `idempotent: true` over MCP: the key an HTTP caller sends as `Idempotency-Key` arrives as the
// reserved `idempotencyKey` tool argument, and reaches `invoke` — so a retried `tools/call` replays
// instead of writing twice. Until 22.6.x the projection called `invoke` with no key at all, and an
// idempotent action was idempotent on every surface but this one.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  action,
  memoryIdempotencyStore,
  registerAction,
  resetRegistry as resetActions,
  resetIdempotency,
  setIdempotencyStore,
} from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { MCP_IDEMPOTENCY_KEY_ARG, takeIdempotencyKeyArg } from './idempotency-arg';
import type { McpCaller } from './registry';
import type { JsonSchema } from './wire';

const caller: McpCaller = {
  actor: agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] }),
  scopes: new Set<string>(),
};

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

let runs = 0;
let seen: unknown[] = [];

const charge = (idempotent: boolean, name = 'chargeCard') =>
  registerAction(
    name,
    action({
      input: t.object({ amount: t.number }),
      output: t.object({ run: t.number }),
      policy: can('card:charge'),
      idempotent,
      mcp: { expose: true, description: 'Charge the card' },
      handle: ({ input }) => {
        seen.push(input);
        runs += 1;
        return { run: runs };
      },
    }),
  );

const call = (args: unknown, id = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name: 'chargeCard', arguments: args },
});

type ToolResponse = {
  result?: { isError?: boolean; content?: { text: string }[] };
  error?: { data?: unknown };
} | null;
const textOf = (response: unknown): string =>
  (response as ToolResponse)?.result?.content?.[0]?.text ?? '';
/** The code an argument refusal names: a tool result carrying `X_INPUT_INVALID` since 22.10. */
const argsRefused = (response: unknown): { code: string | undefined } => {
  const result = (response as ToolResponse)?.result;
  return {
    code: result?.isError === true ? textOf(response).split(':')[0] : undefined,
  };
};

const listedSchema = async (server: ReturnType<typeof defineAppMcp>['server']) => {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, caller);
  const result = response?.result as { tools?: { inputSchema: JsonSchema }[] } | undefined;
  return result?.tools?.[0]?.inputSchema ?? {};
};

beforeEach(() => {
  runs = 0;
  seen = [];
  setIdempotencyStore(memoryIdempotencyStore());
  definePermissions(['card:charge']);
  defineRoles({ owner: { grants: ['card:charge'] } });
});

afterEach(() => {
  resetActions();
  resetIdempotency();
  clearPermissions();
  clearRoles();
});

describe('tools/list advertises the key on idempotent actions only', () => {
  test('an idempotent action carries an optional, bounded string argument', async () => {
    const schema = await listedSchema(defineAppMcp({ actions: [charge(true)] }).server);
    expect(schema.properties?.[MCP_IDEMPOTENCY_KEY_ARG]).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 255,
    });
    // Optional: an agent that never retries sends none, exactly as over HTTP.
    expect(schema.required ?? []).not.toContain(MCP_IDEMPOTENCY_KEY_ARG);
  });

  test('a non-idempotent action advertises nothing, and refuses the argument', async () => {
    const { server } = defineAppMcp({ actions: [charge(false)] });
    expect((await listedSchema(server)).properties).not.toHaveProperty(MCP_IDEMPOTENCY_KEY_ARG);
    const response = await inRequest(() =>
      server.handle(call({ amount: 1, idempotencyKey: 'k1' }), caller),
    );
    expect(argsRefused(response)).toMatchObject({ code: 'X_INPUT_INVALID' });
    expect(runs).toBe(0);
  });

  test('an idempotent action whose input already names the argument is refused at boot', () => {
    const shadowing = registerAction(
      'chargeCard',
      action({
        input: t.object({ idempotencyKey: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('card:charge'),
        idempotent: true,
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }),
    );
    expect(() => defineAppMcp({ actions: [shadowing] })).toThrow(
      expect.objectContaining({ code: 'X_MCP_IDEMPOTENCY_KEY_SHADOWED' }),
    );
  });
});

describe('tools/call hands the key to invoke', () => {
  test('a retry with the same key replays the first result and runs the handler once', async () => {
    const { server } = defineAppMcp({ actions: [charge(true)] });
    const first = await inRequest(() =>
      server.handle(call({ amount: 5, idempotencyKey: 'retry-1' }), caller),
    );
    const retry = await inRequest(() =>
      server.handle(call({ amount: 5, idempotencyKey: 'retry-1' }, 2), caller),
    );
    expect(JSON.parse(textOf(first))).toEqual({ run: 1 });
    expect(JSON.parse(textOf(retry))).toEqual({ run: 1 });
    expect(runs).toBe(1);
    // The action's own input never sees the key — it is the retry's, not the charge's.
    expect(seen).toEqual([{ amount: 5 }]);
  });

  test('a new key, or no key, is a new write', async () => {
    const { server } = defineAppMcp({ actions: [charge(true)] });
    await inRequest(() => server.handle(call({ amount: 5, idempotencyKey: 'a' }), caller));
    await inRequest(() => server.handle(call({ amount: 5, idempotencyKey: 'b' }, 2), caller));
    await inRequest(() => server.handle(call({ amount: 5 }, 3), caller));
    await inRequest(() => server.handle(call({ amount: 5 }, 4), caller));
    expect(runs).toBe(4);
  });

  test('the same key with different arguments is the conflict HTTP answers', async () => {
    const { server } = defineAppMcp({ actions: [charge(true)] });
    await inRequest(() => server.handle(call({ amount: 5, idempotencyKey: 'k' }), caller));
    const conflict = await inRequest(() =>
      server.handle(call({ amount: 9, idempotencyKey: 'k' }, 2), caller),
    );
    expect((conflict as ToolResponse)?.result?.isError).toBe(true);
    expect(textOf(conflict)).toContain('X_IDEMPOTENCY_CONFLICT');
    expect(runs).toBe(1);
  });

  test('an empty key is refused by the advertised schema, before any handler', async () => {
    const { server } = defineAppMcp({ actions: [charge(true)] });
    const response = await inRequest(() =>
      server.handle(call({ amount: 5, idempotencyKey: '' }), caller),
    );
    expect(argsRefused(response)).toMatchObject({ code: 'X_INPUT_INVALID' });
    expect(runs).toBe(0);
  });
});

describe('takeIdempotencyKeyArg', () => {
  test('splits the key off and copies the rest, a __proto__ field included', () => {
    const args = JSON.parse('{"__proto__":{"x":1},"amount":2,"idempotencyKey":"k"}') as unknown;
    const { input, idempotencyKey } = takeIdempotencyKeyArg(args);
    expect(idempotencyKey).toBe('k');
    expect(Object.keys(input as object)).toEqual(['__proto__', 'amount']);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  });

  test('arguments without the key pass through untouched', () => {
    const args = { amount: 2 };
    expect(takeIdempotencyKeyArg(args)).toEqual({ input: args, idempotencyKey: null });
    expect(takeIdempotencyKeyArg(args).input).toBe(args);
  });
});
