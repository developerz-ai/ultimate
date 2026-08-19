/**
 * Two guarantees, and the first one is the ruling: `llm()` returns an `action`, so a model
 * call is not a ninth primitive and every projection an action has, it has. The second is
 * that the model half honours the declaration — structured output, one repair turn, a budget
 * that refuses before spending, and a semantic cache that cannot answer across scopes.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx, isAction } from '@ultimat3/action';
import { createContext, PRIMITIVE_KINDS } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { llm } from './llm';
import {
  ANSWER,
  declare,
  Input,
  install,
  Output,
  POST_ID,
  promptFor,
  stub,
  USAGE,
} from './llm-fixture';
import { ANTHROPIC_MODEL_IDS, DEFAULT_MODEL } from './models';
import type { GenerateRequest, GenerateResult, Provider } from './provider';
import { costOf, EchoProvider } from './provider';
import { resetAiRuntime } from './runtime';

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
    // Verbatim, because `llm()` returns an action and an action's tool name is its export name
    // — the one `@ultimat3/mcp` serves and the only one `tools/call` answers to. It read
    // `summarize_post` until 2026-08, which named a tool no MCP catalog has ever contained.
    expect(summarize.tool().name).toBe('summarizePost');
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

  // The measured failure: the model answered through the `respond` tool, so `result.text` was the
  // EMPTY STRING, and the repair turn replayed it as `{role:'assistant',content:''}` — a 400
  // (`text content blocks must be non-empty`) that surfaced as X_AI_PROVIDER_UNAVAILABLE instead
  // of the X_LLM_OUTPUT_INVALID this loop exists to raise.
  test('never replays an empty assistant turn after a tool-use answer', async () => {
    const { provider, seen } = stub({ summary: 42 }, ANSWER);
    install(provider);
    const summarize = declare(promptFor());

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

    const replayed = seen[1]?.messages ?? [];
    expect(replayed.some((message) => message.content === '')).toBe(false);
  });

  // The tool call's arguments ARE the answer on that path, so replaying them is what gives the
  // repair turn something to repair.
  test("echoes the tool call's own arguments back as the assistant turn", async () => {
    const { provider, seen } = stub({ summary: 42 }, ANSWER);
    install(provider);
    const summarize = declare(promptFor());

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

    const assistant = (seen[1]?.messages ?? []).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe(JSON.stringify({ summary: 42 }));
  });

  test('a prose answer is still echoed verbatim', async () => {
    const { provider, seen } = stub('{"summary": 42}', ANSWER);
    install(provider);
    const summarize = declare(promptFor());

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

    const assistant = (seen[1]?.messages ?? []).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe('{"summary": 42}');
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
      models: ANTHROPIC_MODEL_IDS,
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

describe('cancellation', () => {
  test("the caller's own signal is forwarded to the provider request", async () => {
    // Without it a model call has no cancellation and no deadline: a caller that hung up leaves
    // the provider call in flight, billed and read by nobody — and the repair turn buys a second.
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor());
    const controller = new AbortController();

    await summarize({ postId: POST_ID }, { ctx: createContext({ signal: controller.signal }) });

    expect(seen[0]?.signal).toBe(controller.signal);
  });

  test('the repair turn carries it too — the second call is the expensive one', async () => {
    const { provider, seen } = stub({ summary: 42 }, ANSWER);
    install(provider);
    const summarize = declare(promptFor());
    const controller = new AbortController();

    await summarize({ postId: POST_ID }, { ctx: createContext({ signal: controller.signal }) });

    expect(seen.length).toBe(2);
    expect(seen[1]?.signal).toBe(controller.signal);
  });
});

/** The common declaration, so each test states only the part it is about. */
