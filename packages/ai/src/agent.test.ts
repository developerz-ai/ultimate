/**
 * The tool loop, and the invariant it exists to keep. The failure first, and it is the one a
 * hand-rolled loop ships: taking the ACTOR from the model's output. Everything else here — turn
 * ceiling, per-run budget, tool-result truncation — is the machinery that stops a loop being an
 * unbounded spend, but the actor boundary is the reason the loop belongs in the framework at all.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { action, isAction } from '@ultimat3/action';
import { createContext, PRIMITIVE_KINDS, userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { BudgetLedger, withBudget } from './budget';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const Input = t.object({ orderId: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** One scripted turn: a list of tool calls, or a prose answer. */
type Turn = { readonly calls: readonly { name: string; input: Record<string, unknown> }[] };

function scripted(...turns: readonly Turn[]): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: ['claude-opus-5'],
    generate(request) {
      const turn = turns[Math.min(seen.length, turns.length - 1)];
      seen.push(request);
      const result: GenerateResult = {
        model: 'claude-opus-5',
        text: '',
        toolCalls: (turn?.calls ?? []).map((call, index) => ({
          id: `call-${seen.length}-${index}`,
          name: call.name,
          input: call.input,
        })),
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      };
      return Promise.resolve(result);
    },
    stream: (request) => new EchoProvider().stream(request),
  };
  return { provider, seen };
}

/**
 * A tool that reports the actor it actually ran as. Not a mock of the projection — the real
 * `ProjectableAction` shape `runLlmToolCall` consumes.
 */
function actorProbe(seenActors: string[]): ProjectableAction {
  return {
    name: 'lookupOrder',
    description: 'Look an order up',
    mcp: { expose: true },
    inputJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    run({ actor }) {
      seenActors.push(actor.id);
      return Promise.resolve({ status: 'shipped' });
    },
  };
}

function bulkTool(size: number): ProjectableAction {
  return {
    name: 'dumpRows',
    description: 'Return a lot of rows',
    mcp: { expose: true },
    run: () => Promise.resolve('x'.repeat(size)),
  };
}

let seq = 0;
function promptFor(): Prompt<{ orderId: string }> {
  seq += 1;
  return definePrompt<{ orderId: string }>({
    id: `support-${seq}`,
    version: '1.0.0',
    template: 'Resolve order {{orderId}}.',
  });
}

function ctxAs(id: string) {
  return createContext({ actor: userActor({ id }) });
}

beforeEach(() => {
  resetAiRuntime();
});

describe('the actor boundary', () => {
  // The measured danger of a hand-rolled loop: the model emits `{ actor: 'admin' }` and the loop
  // believes it. Here the model's own output names an actor, and the tool still runs as the one
  // the request established.
  test('a tool runs as the ctx actor, never as one the model named', async () => {
    const seenActors: string[] = [];
    const { provider } = scripted(
      { calls: [{ name: 'lookupOrder', input: { actor: 'admin', id: 'o-1' } }] },
      { calls: [{ name: 'respond', input: { answer: 'shipped' } }] },
    );
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [actorProbe(seenActors)],
      policy: allow(),
    }).named('supportAgent');

    const answer = await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') });
    expect(answer).toEqual({ answer: 'shipped' });
    expect(seenActors).toEqual(['user-7']);
  });

  test("the agent's own policy still decides, before any turn", async () => {
    const { provider, seen } = scripted({ calls: [{ name: 'respond', input: { answer: 'x' } }] });
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: deny('no'),
    }).named('deniedAgent');

    await expect(support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
      code: 'X_FORBIDDEN',
    });
    expect(seen.length).toBe(0);
  });
});

describe('agent() is an action factory, not a ninth primitive', () => {
  test('it returns a real action and declares itself as one of the eight', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
      mcp: { expose: true, description: 'Resolve an order' },
    }).named('projectingAgent');

    expect(isAction(support)).toBe(true);
    expect(PRIMITIVE_KINDS).toContain(support.describe().kind);
    expect(support.describe().kind).toBe('action');
    // The export name verbatim — the same rule `llm()` inherits, for the same reason: an
    // `agent()` is an action, and `@ultimat3/mcp` serves an action under its export name.
    expect(support.tool().name).toBe('projectingAgent');
    expect(support.job().name).toBe('action:projectingAgent');
  });

  // A silently dropped tool reads as wired and is not. Declaration time, because the tools are
  // values by then and a run that discovers it has already been registered and projected.
  test('a tool that is not MCP-exposed is refused at declaration', () => {
    const hidden: ProjectableAction = {
      name: 'secretTool',
      mcp: { expose: false },
      run: () => Promise.resolve(null),
    };
    expect(() =>
      agent({
        input: Input,
        output: Output,
        prompt: promptFor(),
        vars: ({ input }) => ({ orderId: input.orderId }),
        tools: [hidden],
        policy: allow(),
      }),
    ).toThrow('X_AGENT_TOOL_UNEXPOSED');
  });
});

describe('the loop is bounded', () => {
  test('a model that never answers hits X_AGENT_MAX_TURNS, never a partial answer', async () => {
    const { provider, seen } = scripted({ calls: [{ name: 'lookupOrder', input: {} }] });
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [actorProbe([])],
      maxTurns: 3,
      policy: allow(),
    }).named('loopingAgent');

    await expect(support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
      code: 'X_AGENT_MAX_TURNS',
    });
    expect(seen.length).toBe(3);
  });

  test('a per-run token ceiling stops the loop mid-way instead of after it', async () => {
    const { provider, seen } = scripted({ calls: [{ name: 'lookupOrder', input: {} }] });
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [actorProbe([])],
      maxTurns: 10,
      // Enough for the first turn's estimate, not for a second.
      budget: { tokensPerRun: 4_200 },
      policy: allow(),
    }).named('cappedAgent');

    await withBudget(new BudgetLedger({ limits: {} }), async () => {
      await expect(support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
        code: 'X_AI_BUDGET_EXCEEDED',
      });
    });
    expect(seen.length).toBeLessThan(10);
  });

  test('a huge tool result is truncated, and says so', async () => {
    const { provider, seen } = scripted({ calls: [{ name: 'dumpRows', input: {} }] });
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [bulkTool(50_000)],
      maxTurns: 2,
      maxToolResultChars: 100,
      policy: allow(),
    }).named('truncatingAgent');

    await expect(support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
      code: 'X_AGENT_MAX_TURNS',
    });
    const second = seen[1];
    const blocks = second?.messages.at(-1)?.content;
    expect(Array.isArray(blocks)).toBe(true);
    const block = Array.isArray(blocks) ? blocks[0] : undefined;
    const content = block !== undefined && 'content' in block ? block.content : '';
    expect(content.length).toBeLessThan(200);
    expect(content).toContain('[truncated:');
  });

  test('the transcript replays tool_use and tool_result as blocks, so the API can read it', async () => {
    const { provider, seen } = scripted(
      { calls: [{ name: 'lookupOrder', input: { id: 'o-1' } }] },
      { calls: [{ name: 'respond', input: { answer: 'done' } }] },
    );
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [actorProbe([])],
      policy: allow(),
    }).named('transcriptAgent');

    await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') });
    const second = seen[1];
    expect(second?.messages).toHaveLength(3);
    const assistant = second?.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(Array.isArray(assistant?.content) ? assistant?.content[0] : undefined).toMatchObject({
      type: 'tool_use',
      name: 'lookupOrder',
    });
    const results = second?.messages[2];
    expect(Array.isArray(results?.content) ? results?.content[0] : undefined).toMatchObject({
      type: 'tool_result',
    });
  });
});

describe('a real action() is a tool — issue #124', () => {
  // The bug this file could not see: every tool above is a hand-written `ProjectableAction`
  // literal, so the suite was green while `agent({ tools: [publishPost] })` — the shape the
  // README documents — neither typechecked nor ran. A real `action()` carries
  // `as`/`tool`/`openapi`/`job`/`contract` and no `run`, so `runLlmToolCall` reached for a
  // member that has never existed.
  test('an action() declared by an app can be handed straight to agent({ tools })', async () => {
    const seenActors: string[] = [];
    const lookupOrder = action({
      input: t.object({ id: t.string }),
      output: t.object({ status: t.string }),
      policy: allow(),
      mcp: { expose: true, description: 'Look an order up' },
      handle: ({ ctx }) => {
        seenActors.push(ctx.actor.id);
        return { status: 'shipped' };
      },
    }).named('lookupOrder');

    const { provider, seen } = scripted(
      { calls: [{ name: 'lookupOrder', input: { id: 'o-1' } }] },
      { calls: [{ name: 'respond', input: { answer: 'shipped' } }] },
    );
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [lookupOrder],
      policy: allow(),
    }).named('realToolAgent');

    const answer = await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') });
    expect(answer).toEqual({ answer: 'shipped' });
    // The action ran, under the REQUEST's actor.
    expect(seenActors).toEqual(['user-7']);
    // ...and the model was offered the action's own input schema, not the empty stand-in.
    expect(seen[0]?.tools?.find((tool) => tool.name === 'lookupOrder')?.input_schema).toMatchObject(
      {
        properties: { id: { type: 'string' } },
      },
    );
  });
});

describe('an agent can be a tool of another agent', () => {
  // Impossible before the union: `agent()` returns an `Action` and `tools` demanded
  // `ProjectableAction[]`, two disjoint types — so a supervisor delegating to a sub-agent had no
  // spelling at all. It falls out of the factory rule rather than needing a `hive()`: a sub-agent
  // IS an action, and an action is what a tool is.
  test('a supervisor delegates to a sub-agent, which runs under the same actor', async () => {
    const seenActors: string[] = [];
    const inner = scripted({ calls: [{ name: 'respond', input: { answer: 'shipped' } }] });
    const outer = scripted(
      { calls: [{ name: 'orderStatus', input: { orderId: 'o-1' } }] },
      { calls: [{ name: 'respond', input: { answer: 'shipped' } }] },
    );
    // One provider serving both loops: routed by which tools the request offers, so neither
    // script can drift into the other.
    const provider: Provider = {
      name: 'nested',
      models: ['claude-opus-5'],
      generate: (request) =>
        request.tools?.some((tool) => tool.name === 'orderStatus') === true
          ? outer.provider.generate(request)
          : inner.provider.generate(request),
      stream: (request) => new EchoProvider().stream(request),
    };
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const orderStatus = agent({
      input: t.object({ orderId: t.string }),
      output: Output,
      prompt: promptFor(),
      vars: ({ input, ctx }) => {
        seenActors.push(ctx.actor.id);
        return { orderId: input.orderId };
      },
      tools: [],
      policy: allow(),
      mcp: { expose: true, description: 'Answer one order question' },
    }).named('orderStatus');

    const supervisor = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [orderStatus],
      policy: allow(),
    }).named('supervisor');

    expect(await supervisor({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).toEqual({
      answer: 'shipped',
    });
    // The sub-agent ran once, as the REQUEST's actor — a delegated turn is not an escalation.
    expect(seenActors).toEqual(['user-7']);
    // The supervisor was offered the sub-agent under its export name.
    expect(outer.seen[0]?.tools?.map((tool) => tool.name).sort()).toEqual([
      'orderStatus',
      'respond',
    ]);
  });

  test('a sub-agent that never opted into MCP is refused at declaration, like any other tool', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const hidden = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
    }).named('hiddenAgent');

    expect(() =>
      agent({
        input: Input,
        output: Output,
        prompt: promptFor(),
        vars: ({ input }) => ({ orderId: input.orderId }),
        tools: [hidden],
        policy: allow(),
      }),
    ).toThrow('X_AGENT_TOOL_UNEXPOSED');
  });
});
