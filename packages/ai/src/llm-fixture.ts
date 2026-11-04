// The harness `llm.test.ts` and `llm-cache.test.ts` both drive. Shared rather than copied for the
// reason `packages/jobs/src/backfill-pass-fixture.ts` is: two harnesses that drifted would be two
// different declarations agreeing only by construction.
//
// Not shipped — `package.json` excludes `!src/**/*-fixture.ts`, the same rule `@ultimat3/jobs`
// carries for the same file shape.

import { t } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { FIXTURE_MODEL } from './model-fixture';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, Provider, TokenUsage } from './provider';
import { configureAi } from './runtime';
import { scriptedProvider } from './scripted-provider';

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
 * A `scriptedProvider` that answers in order and records what it was asked. A string is a prose
 * answer (the JSON-in-text path), an object is a `respond` tool call (the tool-use path).
 */
export function stub(...answers: readonly (string | Record<string, unknown>)[]): {
  provider: Provider;
  seen: readonly GenerateRequest[];
} {
  const provider = scriptedProvider({
    turns: answers.map((answer) => (typeof answer === 'string' ? { text: answer } : { answer })),
    usage: USAGE,
    name: 'stub',
  });
  return { provider, seen: provider.seen };
}

/** `answer`, `n` times: a script that answers every one of `n` calls alike, spelled out. */
export const times = <T>(n: number, answer: T): T[] => Array.from({ length: n }, () => answer);

export function install(provider: Provider): void {
  configureAi({ gateway: providerGateway({ providers: [provider], defaultModel: FIXTURE_MODEL }) });
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
  return ctxOf({
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
