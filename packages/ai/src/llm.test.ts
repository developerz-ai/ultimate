/**
 * Two guarantees, and the first one is the ruling: `llm()` returns an `action`, so a model
 * call is not a ninth primitive and every projection an action has, it has. The second is
 * that the model half honours the declaration — structured output, one repair turn, a budget
 * that refuses before spending, and a semantic cache that cannot answer across scopes.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx, isAction, t } from '@ultimat3/action';
import { PRIMITIVE_KINDS } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { createGateway } from './gateway';
import { llm } from './llm';
import { DEFAULT_MODEL, MODEL_IDS } from './models';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ summary: t.string, tags: t.array(t.string) });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';
const ANSWER = { summary: 'a post about caching', tags: ['cache'] };

const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * A provider that replays scripted answers and records what it was asked. A string is a prose
 * answer (the JSON-in-text path), an object is a `respond` tool call (the tool-use path).
 */
function stub(...answers: readonly unknown[]): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const echo = new EchoProvider();
  const provider: Provider = {
    name: 'stub',
    models: MODEL_IDS,
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

function install(provider: Provider): void {
  configureAi({ gateway: createGateway({ providers: [provider] }) });
}

let seq = 0;
function promptFor(id?: string, version = '1.0.0'): Prompt<{ postId: string }> {
  seq += 1;
  return definePrompt<{ postId: string }>({
    id: id ?? `summarize-${seq}`,
    version,
    template: 'Summarise post {{postId}} in one sentence.',
  });
}

beforeEach(() => {
  resetAiRuntime();
});

describe('llm() is an action factory, not a ninth primitive', () => {
  test('the value it returns is a real action and projects like one', () => {
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
      mcp: { expose: true, description: 'Summarise a post' },
    }).named('summarizePost');

    expect(isAction(summarize)).toBe(true);
    expect(typeof summarize).toBe('function');
    expect(summarize.tool().name).toBe('summarize_post');
    expect(summarize.openapi().operationId).toBe('summarizePost');
    expect(summarize.contract().length).toBeGreaterThan(0);
    expect(summarize.job().name).toBe('action:summarizePost');
    // The typed client is named in the ruling alongside the other four, so it is pinned
    // alongside them: a projection the ruling promises but nothing exercises is a promise.
    expect(typeof summarize.client({ baseUrl: 'https://example.test' })).toBe('function');
    expect(typeof summarize.as).toBe('function');
  });

  /**
   * The ruling's other half. `llm()` adds no ninth kind, so what it returns must declare
   * itself as one of the eight the framework already has — read from core's canonical list,
   * not a string literal, so adding a ninth kind cannot quietly make this pass.
   */
  test('it declares itself as one of the eight primitives, and that one is `action`', () => {
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('kindLlm');

    const { kind } = summarize.describe();
    expect(PRIMITIVE_KINDS).toContain(kind);
    expect(kind).toBe('action');
  });

  test('the declared policy is the action policy — one authz object, not a copy', () => {
    const policy = allow('llm-read');
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy,
    }).named('policyLlm');
    expect(summarize.policy).toBe(policy);
    expect(summarize.tool().policy).toBe(policy);
  });

  test('a denial happens before the model is reached', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: deny('not for you'),
    }).named('deniedLlm');

    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_FORBIDDEN',
    });
    expect(seen.length).toBe(0);
  });
});

describe('structured output', () => {
  test('the output schema becomes the tool the model must answer through', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor());

    expect(await summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
    expect(seen[0]?.tools?.[0]?.name).toBe('respond');
    expect(seen[0]?.tools?.[0]?.input_schema.properties).toHaveProperty('summary');
    expect(seen[0]?.messages[0]?.content).toContain(POST_ID);
  });

  test('a prose answer with a fenced JSON block still parses', async () => {
    const { provider } = stub(`Sure!\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    install(provider);
    const summarize = declare(promptFor());
    expect(await summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
  });

  test('a bad answer gets exactly one repair turn, and the repair is told what broke', async () => {
    const { provider, seen } = stub({ summary: 42 }, ANSWER);
    install(provider);
    const summarize = declare(promptFor());

    expect(await summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
    expect(seen.length).toBe(2);
    expect(seen[1]?.messages.at(-1)?.content).toContain('failed its schema');
  });

  test('two bad answers throw X_LLM_OUTPUT_INVALID rather than looping', async () => {
    const { provider, seen } = stub({ summary: 42 });
    install(provider);
    const summarize = declare(promptFor());

    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_LLM_OUTPUT_INVALID',
    });
    expect(seen.length).toBe(2);
  });
});

/**
 * A refusal and a truncation are both a 200 carrying no usable answer. Reading them as schema
 * failures reports the wrong cause, offers a fix that does not apply, and spends a repair turn
 * that cannot succeed — so both are decided from `stopReason`, before the answer is parsed.
 */
describe('a response that is not an answer', () => {
  function stopping(
    stopReason: GenerateResult['stopReason'],
    details?: GenerateResult['stopDetails'],
  ) {
    const seen: GenerateRequest[] = [];
    const provider: Provider = {
      name: 'stopping',
      models: MODEL_IDS,
      generate(request) {
        seen.push(request);
        return Promise.resolve({
          model: request.model ?? DEFAULT_MODEL,
          text: '',
          toolCalls: [],
          stopReason,
          stopDetails: details,
          usage: USAGE,
          cost: costOf(request.model ?? DEFAULT_MODEL, USAGE),
        });
      },
      stream: () => new EchoProvider().stream({ messages: [], maxTokens: 1 }),
    };
    return { provider, seen };
  }

  test('a refusal throws X_LLM_REFUSED naming its category, and buys no repair turn', async () => {
    const { provider, seen } = stopping('refusal', {
      type: 'refusal',
      category: 'cyber',
      explanation: 'declined',
    });
    install(provider);
    const summarize = declare(promptFor());

    const failure = await summarize({ postId: POST_ID }, { ctx: anonymousCtx() }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'X_LLM_REFUSED' });
    expect(String(failure)).toContain('cyber');
    // A second attempt buys the same refusal at full price.
    expect(seen.length).toBe(1);
  });

  test('a truncated answer throws X_LLM_TRUNCATED, because the ceiling does not move', async () => {
    const { provider, seen } = stopping('max_tokens');
    install(provider);
    const summarize = declare(promptFor());

    const failure = await summarize({ postId: POST_ID }, { ctx: anonymousCtx() }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'X_LLM_TRUNCATED' });
    expect((failure as { fix: string }).fix).toContain('maxTokens');
    expect(seen.length).toBe(1);
  });
});

describe('budgets refuse before the provider is reached', () => {
  test('a prompt over tokensIn throws and nothing is spent', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
      budget: { tokensIn: 2 },
    }).named('tinyTokenBudget');

    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen.length).toBe(0);
  });

  test('a call over costPerCall throws, and the message is in minor units', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
      budget: { costPerCall: { minor: 1, currency: 'USD' } },
      maxTokens: 64_000,
    }).named('tinyCostBudget');

    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('USD minor units'),
    });
    expect(seen.length).toBe(0);
  });

  test('a budget that fits lets the call through', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
      budget: { tokensIn: 8_000, costPerCall: { minor: 500, currency: 'USD' } },
    }).named('roomyBudget');

    expect(await summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
    expect(seen.length).toBe(1);
  });
});

describe('the semantic cache', () => {
  test('a repeated prompt is answered without a second model call', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.99, ttl: '7d' } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(1);
  });

  test('scopes are separate stores, so one tenant never reads another tenant answer', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    let tenant = 'org-a';
    const summarize = declare(promptFor(), {
      // Same rendered prompt, different scope: a shared store would hit on cosine alone.
      cache: { semantic: { threshold: 0.5, scope: () => tenant } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    tenant = 'org-b';
    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });

  test('a prompt version bump invalidates it — that is what the bump is for', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const cache = { semantic: { threshold: 0.99 } } as const;
    const v1 = declare(promptFor('bumped', '1.0.0'), { cache });
    await v1({ postId: POST_ID }, { ctx: anonymousCtx() });
    await v1({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(1);

    const v2 = declare(promptFor('bumped', '2.0.0'), { cache });
    await v2({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });

  test('an unrelated input misses, so the cache never answers the wrong question', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.99 } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    await summarize({ postId: OTHER_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });
});

describe('the ambient runtime', () => {
  test('no gateway configured names the prompt and the boot call that fixes it', async () => {
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor('ungatewayed'),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('noGatewayLlm');

    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_AI_GATEWAY_MISSING',
      cause: expect.stringContaining('ungatewayed@1.0.0'),
      fix: expect.stringContaining('configureAi'),
    });
  });
});

let declared = 0;
/** The common declaration, so each test states only the part it is about. */
function declare(
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
