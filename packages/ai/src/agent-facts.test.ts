/**
 * What a manifest can say about an agent. The failure this exists for: `x manifest` published an
 * agent as an ordinary action row — name, schemas, policy — and nothing at all about the two facts
 * that decide what it can do to you, which are how far it may loop and what it may call.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { describeAgents, resetAgents } from './agent-facts';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import { EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const Input = t.object({ orderId: t.string });
const Output = t.object({ answer: t.string });

let seq = 0;
function promptFor(): Prompt<{ orderId: string }> {
  seq += 1;
  return definePrompt<{ orderId: string }>({
    id: `facts-${seq}`,
    version: '2.1.0',
    template: 'Resolve order {{orderId}}.',
  });
}

const tool = (name: string): ProjectableAction => ({
  name,
  mcp: { expose: true },
  run: () => Promise.resolve(null),
});

beforeEach(() => {
  resetAiRuntime();
  resetAgents();
  resetRegistry();
  configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
});

describe('describeAgents', () => {
  test('publishes the turn ceiling, the tool catalogue and the budget, under the export name', () => {
    const prompt = promptFor();
    const support = agent({
      input: Input,
      output: Output,
      prompt,
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [tool('refund'), tool('lookupOrder')],
      maxTurns: 3,
      maxToolResultChars: 500,
      budget: { tokensPerRun: 90_000, costPerCall: { minor: 50, currency: 'USD' } },
      policy: allow(),
      mcp: { expose: true },
    });
    registerAction('supportAgent', support);

    expect(describeAgents()).toEqual([
      {
        name: 'supportAgent',
        prompt: prompt.ref,
        promptId: prompt.id,
        promptHash: prompt.hash,
        model: 'claude-opus-5',
        maxTurns: 3,
        maxToolResultChars: 500,
        // Sorted, so a manifest diff is about the catalogue and not about declaration order.
        tools: ['lookupOrder', 'refund'],
        budget: {
          tokensIn: null,
          tokensPerRun: 90_000,
          costPerCall: { minor: 50, currency: 'USD' },
        },
        mcp: true,
      },
    ]);
  });

  test('the defaults an agent inherits are published as the numbers, never as absence', () => {
    const plain = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
    });
    registerAction('plainAgent', plain);

    const [fact] = describeAgents();
    // A row saying "maxTurns: null" would make an inherited ceiling read as no ceiling.
    expect(fact?.maxTurns).toBe(8);
    expect(fact?.maxToolResultChars).toBe(4_000);
    expect(fact?.budget).toEqual({ tokensIn: null, tokensPerRun: null, costPerCall: null });
    expect(fact?.mcp).toBe(false);
  });

  // The reason the facts are a THUNK. `agent()` runs at module scope beside the actions it lists,
  // and every name in the row — the agent's and its tools' — is stamped by `registerAction` after
  // that. Read at declaration, the tool catalogue is a list of `(an unregistered action)`.
  test('a real action tool is named from its registration, not from declaration order', () => {
    const lookupOrder = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      mcp: { expose: true },
      handle: () => ({ ok: true }),
    });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [lookupOrder],
      policy: allow(),
    });
    // Boot order: declare, then register — the tool is nameless while `agent()` runs.
    registerAction('lookupOrder', lookupOrder);
    registerAction('supportAgent', support);

    expect(describeAgents()[0]?.tools).toEqual(['lookupOrder']);
  });

  test('an agent nothing registered is not a capability, so it has no row', () => {
    agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
    });
    expect(describeAgents()).toEqual([]);
  });

  test('rows are sorted by name, so a manifest diff is a real diff', () => {
    for (const name of ['zeta', 'alpha', 'mid']) {
      registerAction(
        name,
        agent({
          input: Input,
          output: Output,
          prompt: promptFor(),
          vars: ({ input }) => ({ orderId: input.orderId }),
          tools: [],
          policy: allow(),
        }),
      );
    }
    expect(describeAgents().map((fact) => fact.name)).toEqual(['alpha', 'mid', 'zeta']);
  });
});
