import { afterEach, describe, expect, test } from 'bun:test';
import { action } from '@ultimat3/action';
import { agentActor, ctxOf, resetPublicCauses, stringField, UltimateError } from '@ultimat3/core';
import { driverError } from '@ultimat3/db';
import { registerErrorStatus, registerProblemMeta, resetErrorStatus } from '@ultimat3/http';
import { resetRateLimitStore } from '@ultimat3/http/adapter';
import { allow, policyForbidden } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { satisfiesStrictMode, toOpenAiTools } from './openai-messages';
import type { ProjectableAction } from './tools';
import {
  asProjectableAction,
  HIDDEN_TOOL_CAUSE,
  runLlmToolCall,
  toLlmTool,
  toLlmTools,
} from './tools';

const actor = agentActor({ id: 'agent-1' });

afterEach(() => {
  resetErrorStatus();
  resetPublicCauses();
});

const projectable = (
  name: string,
  mcp?: ProjectableAction['mcp'],
  run?: ProjectableAction['run'],
): ProjectableAction => ({
  name,
  ...(mcp === undefined ? {} : { mcp }),
  inputJsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run: run ?? (async ({ input }) => ({ ran: name, input })),
});

describe('toLlmTool', () => {
  test('the mcp description wins, then the primitive description, then a derived line', () => {
    expect(toLlmTool(projectable('publishPost', { expose: true, description: 'Publish' }))).toEqual(
      {
        name: 'publishPost',
        description: 'Publish',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        strict: true,
      },
    );
    expect(toLlmTool({ ...projectable('publishPost'), description: 'From the primitive' })).toEqual(
      expect.objectContaining({ description: 'From the primitive' }),
    );
    expect(toLlmTool(projectable('publishPost')).description).toBe('Run the "publishPost" action.');
  });

  test('an action with no input schema still projects a callable, empty object schema', () => {
    const tool = toLlmTool({ name: 'ping', run: async () => 'pong' });
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(tool.strict).toBe(true);
  });

  // `strict: true` on the tool is the PREFERENCE every projection asks for, never a granted flag: a
  // projected action input carries `additionalProperties: true`, which OpenAI's strict mode refuses
  // (it must list every key in `required` AND close the object), so the schema rides unchanged and
  // that wire drops the flag rather than sending a promise the server answers with a 400.
  test('a projected action keeps its open input schema, and the OpenAI wire withholds strict', () => {
    const tool = toLlmTool(
      asProjectableAction(
        action({
          input: t.object({ id: t.string }),
          output: t.object({ ok: t.boolean }),
          policy: allow(),
          mcp: { expose: true },
          handle: () => ({ ok: true }),
        }).named('noteOn'),
      ),
    );

    expect(tool.input_schema.additionalProperties).toBe(true);
    expect(Object.keys(tool.input_schema.properties as object)).toEqual(['id']);
    expect(tool.input_schema.required).toEqual(['id']);
    expect(tool.strict).toBe(true);
    // The open schema is exactly the case strict mode refuses, so no test may read the flag back as
    // granted: the sent document is the same schema, and `strict` is absent from it.
    expect(satisfiesStrictMode(tool.input_schema)).toBe(false);
    const sent = toOpenAiTools([tool])[0];
    expect(sent?.function.parameters).toEqual(tool.input_schema);
    expect(sent?.function.strict).toBeUndefined();
  });

  test('a closed hand-built schema is the one case the OpenAI wire does claim strict for', () => {
    const closed = toLlmTool({ name: 'ping', run: async () => 'pong' });
    expect(satisfiesStrictMode(closed.input_schema)).toBe(true);
    expect(toOpenAiTools([closed])[0]?.function.strict).toBe(true);
  });
});

// The gateway offers the same tools MCP does, because both ask `isMcpExposed`. A second, looser
// rule here would hand an in-app agent a capability the external one is refused.
describe('exposure is opt-in, the same opt-in MCP reads', () => {
  test('only a literal expose: true reaches the model, in stable name order', () => {
    const tools = toLlmTools([
      projectable('publishPost', { expose: true }),
      projectable('deleteOrg'),
      projectable('archivePost', { expose: false }),
      projectable('inviteMember', { expose: true }),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['inviteMember', 'publishPost']);
  });

  test('an un-exposed action is unknown to a tool call, even by exact name', async () => {
    let ran = false;
    const actions = [
      projectable('deleteOrg', undefined, async () => {
        ran = true;
        return 'gone';
      }),
    ];
    const result = await runLlmToolCall(
      actions,
      { id: 'call-1', name: 'deleteOrg', input: { id: 'o1' } },
      actor,
    );
    expect(ran).toBe(false);
    expect(result).toEqual({
      toolUseId: 'call-1',
      content: 'unknown tool: deleteOrg',
      isError: true,
    });
  });

  test('an exposed action runs and its output comes back as JSON', async () => {
    const result = await runLlmToolCall(
      [projectable('publishPost', { expose: true })],
      { id: 'call-2', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ ran: 'publishPost', input: { id: 'p1' } });
  });
});

describe('runLlmToolCall renders a failure the model can act on', () => {
  // The real denial an action's policy gate throws, not a hand-rolled lookalike: a duck-typed
  // `{ code, cause, fix }` would keep passing after `PolicyError` stopped carrying one of them.
  test('a framework error keeps its code and cause, and says what a caller does', async () => {
    const denied = projectable('publishPost', { expose: true }, async () => {
      throw policyForbidden('post:publish', 'actor lacks post:publish');
    });
    const result = await runLlmToolCall(
      [denied],
      { id: 'call-3', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({
      toolUseId: 'call-3',
      content:
        'X_FORBIDDEN: post:publish denied: actor lacks post:publish ' +
        '(fix: this caller lacks the permission post:publish: ask the account owner or an administrator to grant it, or call with credentials that have it — retrying the same call is refused the same way)',
      isError: true,
    });
  });

  // A throw from outside the framework — an SDK, a driver — is what this branch exists for, so
  // the test has to raise one. It carries no `code`, which is the whole subject: an
  // `UltimateError` here would exercise the branch above instead.
  class ThirdPartySdkError extends Error {
    override readonly name = 'ThirdPartySdkError';
  }

  test('a foreign throw is reported without inventing a code', async () => {
    const boom = projectable('publishPost', { expose: true }, async () => {
      throw new ThirdPartySdkError('kaboom');
    });
    const result = await runLlmToolCall(
      [boom],
      { id: 'call-4', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({ toolUseId: 'call-4', content: 'tool failed', isError: true });
  });
});

// The values here are the ones the framework did not build: a tool's OUTPUT and a tool's THROW
// both come from an app's own code, and `LlmToolResult.content` is typed `string` — the agent
// loop truncates it, so anything else ends the whole run in a `TypeError` two frames away.
describe('runLlmToolCall survives a result the framework did not build', () => {
  test('a tool that returns nothing answers null, never a content that is not a string', async () => {
    const silent = projectable('publishPost', { expose: true }, async () => undefined);
    const result = await runLlmToolCall(
      [silent],
      { id: 'call-5', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({ toolUseId: 'call-5', content: 'null' });
    expect(typeof result.content).toBe('string');
  });

  // `JSON.stringify` throws on a bigint and on a cycle, and RUNS any `toJSON` the value carries.
  // The tool already ran, so telling the model it failed would buy a second run of its side
  // effects — the result says the call succeeded and the value cannot be read.
  test('an unserialisable result is reported as one, and never as a failed call', async () => {
    for (const output of [
      { total: 10n },
      (() => {
        const cycle: Record<string, unknown> = {};
        cycle['self'] = cycle;
        return cycle;
      })(),
      {
        toJSON() {
          throw new Error('no');
        },
      },
    ]) {
      const odd = projectable('publishPost', { expose: true }, async () => output);
      const result = await runLlmToolCall(
        [odd],
        { id: 'call-6', name: 'publishPost', input: { id: 'p1' } },
        actor,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not JSON');
      expect(result.content).toContain('ran');
    }
  });

  // The throw a `catch` block cannot read: `typeof error.code` is a getter call, and on a `Proxy`
  // it is a trap. The branch that renders a denial must not be the branch that raises one.
  test('a throw that fights being read is still a tool_result, not a raised TypeError', async () => {
    const hostile: unknown[] = [
      new Proxy(
        {},
        {
          get() {
            throw new Error('trapped get');
          },
          getPrototypeOf() {
            throw new Error('trapped getPrototypeOf');
          },
        },
      ),
      Object.defineProperty(Object.create(null), 'code', {
        get() {
          throw new Error('trapped getter');
        },
        enumerable: true,
      }),
      Symbol('thrown'),
    ];
    for (const value of hostile) {
      const boom = projectable('publishPost', { expose: true }, () => Promise.reject(value));
      const result = await runLlmToolCall(
        [boom],
        { id: 'call-7', name: 'publishPost', input: { id: 'p1' } },
        actor,
      );
      expect(result).toEqual({ toolUseId: 'call-7', content: 'tool failed', isError: true });
    }
  });

  // A null-prototype error object is what a worker, a subprocess or a JSON round trip produces,
  // and it still carries the three fields — reading them must not depend on a prototype.
  // A 4xx the app declared: the redaction rule below only touches a 5xx, so this pins the reader.
  test('a null-prototype error object still renders its code, cause and fix', async () => {
    registerErrorStatus({ X_ORDER_LOCKED: 409 });
    const flattened = Object.assign(Object.create(null), {
      code: 'X_ORDER_LOCKED',
      cause: 'order o-1 is closed',
      fix: 'x doctor --json',
    });
    const boom = projectable('publishPost', { expose: true }, () => Promise.reject(flattened));
    const result = await runLlmToolCall(
      [boom],
      { id: 'call-8', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({
      toolUseId: 'call-8',
      content: 'X_ORDER_LOCKED: order o-1 is closed (fix: x doctor --json)',
      isError: true,
    });
  });
});

// The verdict `@ultimat3/http`'s `error-facts-public-cause.test.ts` pins for a problem document,
// asked of the one other renderer that sends a throw off the box: the model's provider. A cause
// leaked here cannot be recalled — it is in a third party's request log.
describe('runLlmToolCall withholds a 5xx cause the code did not declare public', () => {
  const failing = (thrown: unknown) =>
    projectable('publishPost', { expose: true }, () => Promise.reject(thrown));
  const call = async (thrown: unknown) =>
    (
      await runLlmToolCall(
        [failing(thrown)],
        { id: 'call-r', name: 'publishPost', input: { id: 'p1' } },
        actor,
      )
    ).content;

  test('X_DB_STATEMENT_FAILED: the code and a fixed sentence, never the server message', async () => {
    const thrown = driverError('select password_hash from x_users', {
      code: '42P99',
      message: 'column "password_hash" does not exist',
    });
    expect(stringField(thrown, 'code')).toBe('X_DB_STATEMENT_FAILED');
    const content = await call(thrown);
    expect(content).toBe(`X_DB_STATEMENT_FAILED: ${HIDDEN_TOOL_CAUSE}`);
    expect(content).not.toContain('password_hash');
    expect(content).not.toContain('psql');
  });

  test('an app code with no status is a 500 and hidden; declared public, it is shown', async () => {
    const thrown = new UltimateError({
      code: 'X_APP_UPSTREAM_DOWN',
      cause: 'billing at 10.0.0.4 refused',
      fix: 'curl http://10.0.0.4/health',
    });
    expect(await call(thrown)).toBe(`X_APP_UPSTREAM_DOWN: ${HIDDEN_TOOL_CAUSE}`);
    registerErrorStatus({ X_APP_UPSTREAM_DOWN: 502 });
    expect(await call(thrown)).not.toContain('10.0.0.4');
    registerProblemMeta({ X_APP_UPSTREAM_DOWN: { publicCause: true } });
    expect(await call(thrown)).toContain('billing at 10.0.0.4 refused');
  });

  test('a framework-public 5xx keeps its cause: the instruction is the point of it', async () => {
    const thrown = new UltimateError({
      code: 'X_DRAINING',
      cause: 'this node is draining',
      fix: 'retry',
    });
    expect(await call(thrown)).toBe('X_DRAINING: this node is draining (fix: retry)');
  });

  test('a hidden failure keeps the caller fix it declared, and only a branded one', async () => {
    const declared = new UltimateError({
      code: 'X_APP_UPSTREAM_DOWN',
      cause: 'billing at 10.0.0.4 refused',
      fix: 'curl http://10.0.0.4/health',
      callerFix: 'retry in a minute',
    });
    expect(await call(declared)).toBe(
      `X_APP_UPSTREAM_DOWN: ${HIDDEN_TOOL_CAUSE} (fix: retry in a minute)`,
    );
    const foreign = { code: 'X_APP_UPSTREAM_DOWN', cause: 'secret', callerFix: 'curl evil' };
    expect(await call(foreign)).toBe(`X_APP_UPSTREAM_DOWN: ${HIDDEN_TOOL_CAUSE}`);
  });
});

/**
 * The in-app agent ends at `invoke` like every other surface, so a declared `rateLimit:` refuses
 * the model's third call exactly as it refuses an HTTP client's — and the model reads the 429's
 * code and cause, which is a caller-facing 4xx and is not withheld.
 */
describe('a tool with a declared rate limit', () => {
  afterEach(() => resetRateLimitStore());

  test("the agent's call past the limit is refused X_RATE_LIMITED", async () => {
    resetRateLimitStore();
    const tool = asProjectableAction(
      action({
        input: t.object({ id: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        rateLimit: { limit: 2, windowMs: 60_000 },
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }).named('pingOnce'),
    );
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await runLlmToolCall(
          [tool],
          { id: `call-${i}`, name: 'pingOnce', input: { id: 'p' } },
          actor,
        ),
      );
    }
    expect(results.map((result) => result.isError === true)).toEqual([false, false, true]);
    expect(results[2]?.content).toStartWith('X_RATE_LIMITED: ');
  });
});

/**
 * An in-app agent's tool calls carry no address of their own — `runLlmToolCall` invokes with the
 * actor alone — so they are keyed by the address of the request the agent run started from.
 * Without it every anonymous visitor shared one `ip:unknown` bucket and one could deny them all.
 */
describe('an anonymous visitor’s tool calls', () => {
  afterEach(() => resetRateLimitStore());

  test('are keyed by that visitor’s address, so one visitor cannot exhaust another', async () => {
    resetRateLimitStore();
    const tool = asProjectableAction(
      action({
        input: t.object({ id: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        rateLimit: { limit: 1, windowMs: 60_000 },
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }).named('lookUp'),
    );
    // The agent run, as an action invoked over HTTP — the surface that knows the address.
    const run = action({
      input: t.object({ id: t.string }),
      output: t.object({ refused: t.boolean }),
      policy: allow(),
      handle: async ({ input, ctx }) => {
        const result = await runLlmToolCall(
          [tool],
          { id: 'c', name: 'lookUp', input: { id: input.id } },
          ctx.actor,
        );
        return { refused: result.isError === true };
      },
    }).named('askAgent');
    const visit = async (clientAddress: string) =>
      (
        (await run({ id: 'p' }, { ctx: ctxOf({}), surface: 'http', clientAddress })) as {
          refused: boolean;
        }
      ).refused;
    expect(await visit('198.51.100.1')).toBe(false);
    expect(await visit('198.51.100.1')).toBe(true);
    expect(await visit('198.51.100.2')).toBe(false);
  });
});
