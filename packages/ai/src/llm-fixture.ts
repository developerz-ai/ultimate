// The harness `llm.test.ts` and `llm-cache.test.ts` both drive. Shared rather than copied for the
// reason `packages/jobs/src/backfill-pass-fixture.ts` is: two harnesses that drifted would be two
// different declarations agreeing only by construction.
//
// Not shipped — `package.json` excludes `!src/**/*-fixture.ts`, the same rule `@ultimat3/jobs`
// carries for the same file shape.

import { t } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { createContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { createGateway } from './gateway';
import { llm } from './llm';
import { ANTHROPIC_MODEL_IDS, DEFAULT_MODEL } from './models';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi } from './runtime';

export const Input = t.object({ postId: t.uuid });
export const Output = t.object({ summary: t.string, tags: t.array(t.string) });
export const POST_ID = '00000000-0000-4000-8000-0000000000aa';
export const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';
export const ANSWER = { summary: 'a post about caching', tags: ['cache'] };

export const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * A provider that replays scripted answers and records what it was asked. A string is a prose
 * answer (the JSON-in-text path), an object is a `respond` tool call (the tool-use path).
 */
export function stub(...answers: readonly unknown[]): {
  provider: Provider;
  seen: GenerateRequest[];
} {
  const seen: GenerateRequest[] = [];
  const echo = new EchoProvider();
  const provider: Provider = {
    name: 'stub',
    models: ANTHROPIC_MODEL_IDS,
    generate(request) {
      const answer = answers[Math.min(seen.length, answers.length - 1)];
      seen.push(request);
      return Promise.resolve(reply(request, answer));
    },
    stream: (request) => echo.stream(request),
  };
  return { provider, seen };
}

function reply(request: GenerateRequest, answer: unknown): GenerateResult {
  const model = request.model ?? DEFAULT_MODEL;
  const prose = typeof answer === 'string';
  return {
    model,
    text: prose ? answer : '',
    toolCalls: prose
      ? []
      : [{ id: 'call-1', name: 'respond', input: answer as Record<string, unknown> }],
    stopReason: prose ? 'end_turn' : 'tool_use',
    stopDetails: undefined,
    usage: USAGE,
    cost: costOf(model, USAGE),
  };
}

export function install(provider: Provider): void {
  configureAi({ gateway: createGateway({ providers: [provider] }) });
}

let seq = 0;
export function promptFor(id?: string, version = '1.0.0'): Prompt<{ postId: string }> {
  seq += 1;
  return definePrompt<{ postId: string }>({
    id: id ?? `summarize-${seq}`,
    version,
    template: 'Summarise post {{postId}} in one sentence.',
  });
}

/** An authenticated caller. The default scope is derived from exactly these three fields. */
export function ctxFor(id: string, orgId: string, locale?: string): Ctx {
  return createContext({
    actor: userActor({ id, orgId }),
    ...(locale === undefined ? {} : { locale }),
  });
}

let declared = 0;

/** A named `llm()` over the shared schemas. The counter keeps every twin's action name unique. */
export function declare(
  prompt: Prompt<{ postId: string }>,
  extra: Partial<Parameters<typeof llm<typeof Input, typeof Output, { postId: string }>>[0]> = {},
) {
  declared += 1;
  return llm({
    input: Input,
    output: Output,
    prompt,
    vars: ({ input }) => ({ postId: input.postId }),
    policy: allow(),
    ...extra,
  }).named(`declaredLlm${declared}`);
}
