// TEST-ONLY. The hive suites' shared members, prompts and actor: one fake provider by prompt,
// a gated worker for out-of-order completion, and a microtask pump in place of a clock.

import { action } from '@ultimat3/action';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, messageText } from './provider';

export const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Keyed by the rendered prompt, never by call count: members run concurrently, so `seen.length`
 * would decide a reply by whichever worker happened to win the tick.
 */
export function byPrompt(
  fail: (prompt: string) => boolean = () => false,
  /**
   * Microtasks the provider holds a call open for. The scheduler seam the budget case needs: a
   * reservation is only overlapping if the first member has not RECORDED before the others
   * reserve, and holding the socket open is exactly what a real call does.
   */
  hold = 0,
): {
  provider: Provider;
  seen: string[];
} {
  const seen: string[] = [];
  const provider: Provider = {
    name: 'keyed',
    async generate(request) {
      const prompt = request.messages.map(messageText).join(' ');
      seen.push(prompt);
      if (fail(prompt)) {
        // A 400 is never retried, so one refusal is one provider call — the test can count them.
        throw Object.assign(new Error('no'), { status: 400 });
      }
      if (hold > 0) await ticks(hold);
      return {
        model: 'claude-opus-5',
        text: '',
        toolCalls: [{ id: 'c1', name: 'respond', input: { echo: prompt } }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      } satisfies GenerateResult;
    },
    models: ['claude-opus-5'],
    stream: (request) => echoProvider().stream(request),
  };
  return { provider, seen };
}

let seq = 0;
export function promptFor(): Prompt<{ topic: string }> {
  seq += 1;
  return definePrompt<{ topic: string }>({
    id: `hive-${seq}`,
    version: '1.0.0',
    template: 'Work on {{topic}}.',
  });
}

/** A member that is an ordinary action — the deterministic half, with no model in it. */
export function worker(log: string[], gate?: Promise<unknown>, open?: () => void) {
  return action({
    input: t.object({ id: t.string }),
    output: t.object({ id: t.string, actor: t.string }),
    policy: allow(),
    mcp: { expose: true },
    async handle({ input, ctx }) {
      if (input.id === 'slow' && gate !== undefined) await gate;
      if (input.id === 'fast' && open !== undefined) open();
      log.push(input.id);
      return { id: input.id, actor: ctx.actor.id };
    },
  }).named('workOne');
}

/** A member that is a real `agent()`, so the model path, the budget and the span are all live. */
export function modelWorker(name: string) {
  return agent({
    input: t.object({ topic: t.string }),
    output: t.object({ echo: t.string }),
    prompt: promptFor(),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [],
    policy: allow(),
  }).named(name);
}

export const ctxAs = (id: string) => ctxOf({ actor: userActor({ id }) });

/**
 * The scheduler seam. `ticks(n)` settles after n microtasks — so a pool that never runs the member
 * which opens the gate FAILS on the ordering assertion instead of hanging the suite, and nothing
 * in this file consults a clock.
 */
export async function ticks(count: number): Promise<'timeout'> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
  return 'timeout';
}
