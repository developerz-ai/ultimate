/**
 * The transcript the next turn replays, and the one rule the Messages API enforces about it:
 * every `tool_use` block an assistant turn carries must be answered by a `tool_result` in the very
 * next message. A transcript that breaks it is a 400 — an `X_AI_PROVIDER_UNAVAILABLE` in place of
 * a completed run — so it is asserted structurally here rather than trusted per case.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import type { AiMessage, GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi } from './runtime';
import type { ProjectableAction } from './tools';

const Input = t.object({ orderId: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Turn = { readonly calls: readonly { name: string; input: Record<string, unknown> }[] };

function scripted(...turns: readonly Turn[]): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: ['claude-opus-5'],
    generate(request) {
      const turn = turns[Math.min(seen.length, turns.length - 1)];
      seen.push(request);
      return Promise.resolve({
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
      } satisfies GenerateResult);
    },
    stream: (request) => new EchoProvider().stream(request),
  };
  return { provider, seen };
}

function lookupTool(): ProjectableAction {
  return {
    name: 'lookupOrder',
    description: 'Look an order up',
    mcp: { expose: true },
    run: () => Promise.resolve({ status: 'shipped' }),
  };
}

let seq = 0;
function promptFor(): Prompt<{ orderId: string }> {
  seq += 1;
  return definePrompt<{ orderId: string }>({
    id: `transcript-${seq}`,
    version: '1.0.0',
    template: 'Resolve order {{orderId}}.',
  });
}

function ctxAs(id: string) {
  return createContext({ actor: userActor({ id }) });
}

const blocksOf = (message: AiMessage | undefined) =>
  Array.isArray(message?.content) ? message.content : [];

/**
 * The API's rule, executable: the ids a transcript asks about and never answers. Each `tool_use`
 * is looked up in the message that FOLLOWS its own, because that is the only place the Messages
 * API accepts the answer.
 */
function unansweredToolUses(messages: readonly AiMessage[]): readonly string[] {
  const open: string[] = [];
  for (const [index, message] of messages.entries()) {
    const asked = blocksOf(message)
      .filter((block) => block.type === 'tool_use')
      .map((block) => (block.type === 'tool_use' ? block.id : ''));
    if (asked.length === 0) continue;
    const answered = new Set(
      blocksOf(messages[index + 1])
        .filter((block) => block.type === 'tool_result')
        .map((block) => (block.type === 'tool_result' ? block.tool_use_id : '')),
    );
    open.push(...asked.filter((id) => !answered.has(id)));
  }
  return open;
}

describe('every tool_use the transcript replays is answered', () => {
  // Parallel tool use: one turn asks for a tool AND answers. The answer was written before the
  // tool result existed, so the loop keeps going — and the `respond` block it replays needs a
  // `tool_result` of its own or the next request is a 400.
  test('a turn that calls a tool AND respond leaves no tool_use unanswered', async () => {
    const { provider, seen } = scripted(
      {
        calls: [
          { name: 'lookupOrder', input: { id: 'o-1' } },
          { name: 'respond', input: { answer: 'guessed' } },
        ],
      },
      { calls: [{ name: 'respond', input: { answer: 'shipped' } }] },
    );
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [lookupTool()],
      policy: allow(),
    }).named('parallelAgent');

    // The run completes on the SECOND turn's answer: the speculative one was written without the
    // tool result the same turn asked for.
    expect(await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).toEqual({
      answer: 'shipped',
    });
    const replayed = seen[1]?.messages ?? [];
    expect(unansweredToolUses(replayed)).toEqual([]);
    // The real tool's result is still first, and the rejected answer is flagged so the model does
    // not read it as data.
    const results = blocksOf(replayed[2]);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1-0' });
    expect(results[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-1-1',
      is_error: true,
    });
  });

  // The same hole on the repair path: a `respond` whose input fails the output schema is replayed
  // as a `tool_use`, and the correction that follows it has to be that call's `tool_result`.
  test('a repair turn answers the respond call it is correcting', async () => {
    const { provider, seen } = scripted(
      { calls: [{ name: 'respond', input: { answer: 42 } }] },
      { calls: [{ name: 'respond', input: { answer: 'shipped' } }] },
    );
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [lookupTool()],
      policy: allow(),
    }).named('repairAgent');

    expect(await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).toEqual({
      answer: 'shipped',
    });
    const replayed = seen[1]?.messages ?? [];
    expect(unansweredToolUses(replayed)).toEqual([]);
    const correction = blocksOf(replayed[2])[0];
    expect(correction).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1-0' });
    expect(correction && 'content' in correction ? correction.content : '').toContain(
      'failed its schema',
    );
  });

  // A model that answers in prose emits no `tool_use` at all, so the correction stays an ordinary
  // user message — a `tool_result` naming nothing would be the 400 in the other direction.
  test('a prose answer is corrected with a plain user message', async () => {
    const seen: GenerateRequest[] = [];
    const provider: Provider = {
      name: 'prose',
      models: ['claude-opus-5'],
      generate(request) {
        seen.push(request);
        return Promise.resolve({
          model: 'claude-opus-5',
          text: seen.length === 1 ? '{"answer":42}' : '{"answer":"shipped"}',
          toolCalls: [],
          stopReason: 'end_turn',
          stopDetails: undefined,
          usage: USAGE,
          cost: costOf('claude-opus-5', USAGE),
        } satisfies GenerateResult);
      },
      stream: (request) => new EchoProvider().stream(request),
    };
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [lookupTool()],
      policy: allow(),
    }).named('proseAgent');

    expect(await support({ orderId: 'o-1' }, { ctx: ctxAs('user-7') })).toEqual({
      answer: 'shipped',
    });
    const replayed = seen[1]?.messages ?? [];
    expect(unansweredToolUses(replayed)).toEqual([]);
    expect(replayed[2]?.content).toContain('failed its schema');
  });
});
