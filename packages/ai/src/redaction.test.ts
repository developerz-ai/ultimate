/**
 * The seam between `vars()` and the provider. The failure first: a health-adjacent feature whose
 * `vars()` returns the patient row, whose full name and DOB reach a third-party endpoint, and
 * where nothing in the framework records that it happened.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx, t } from '@ultimat3/action';
import { secret } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { createGateway } from './gateway';
import { llm } from './llm';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, Provider } from './provider';
import { costOf, EchoProvider } from './provider';
import { assertNoSecrets } from './redaction';
import { aiRedactor, configureAi, resetAiRuntime } from './runtime';

const Input = t.object({ patientId: t.uuid });
const Output = t.object({ value: t.string });
const PATIENT = '00000000-0000-4000-8000-0000000000aa';

/** Records what was actually sent, and answers through `respond` so the output schema is met. */
function recorder(): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const echo = new EchoProvider();
  const usage = { inputTokens: 4, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const provider: Provider = {
    name: 'recorder',
    models: ['claude-opus-5'],
    generate(request) {
      seen.push(request);
      return Promise.resolve({
        model: 'claude-opus-5',
        text: '',
        toolCalls: [{ id: 'c1', name: 'respond', input: { value: 'summarised' } }],
        stopReason: 'tool_use' as const,
        stopDetails: undefined,
        usage,
        cost: costOf('claude-opus-5', usage),
      });
    },
    stream: (request) => echo.stream(request),
  };
  return { provider, seen };
}

let seq = 0;
function promptFor(template: string): Prompt<Record<string, string>> {
  seq += 1;
  return definePrompt<Record<string, string>>({
    id: `redact-${seq}`,
    version: '1.0.0',
    template,
    system: 'You are a clinical summariser for {{unused}}.'.replace('{{unused}}', 'a hospital'),
  });
}

beforeEach(() => {
  resetAiRuntime();
});

describe('a Secret never reaches a prompt', () => {
  // Not a leak — `Secret` renders `[redacted]` by value, so the string would have been safe. It is
  // a prompt that reads fine and means something else, bought at full price.
  test('assertNoSecrets refuses, naming every key that carries one', () => {
    expect(() =>
      assertNoSecrets('p@1', { name: 'Ada', token: secret('sk-live', 'apiToken') }),
    ).toThrow('X_AI_PROMPT_SECRET');
    try {
      assertNoSecrets('p@1', { a: secret('x'), b: secret('y'), c: 'plain' });
      expect.unreachable();
    } catch (error) {
      // Every offending key, sorted, and only those — `c` is an ordinary string and stays out.
      expect((error as { cause: string }).cause).toEndWith(': a, b');
    }
  });

  test('it lets an ordinary variable through', () => {
    expect(() => assertNoSecrets('p@1', { name: 'Ada', age: 36, ok: true })).not.toThrow();
  });

  test('an llm() whose vars() returns a Secret refuses before the provider is touched', async () => {
    const { provider, seen } = recorder();
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor('Summarise the note for {{patientId}} using {{apiToken}}.'),
      vars: ({ input }) => ({ patientId: input.patientId, apiToken: secret('sk-live') }) as never,
      policy: allow(),
    }).named('secretVars');

    await expect(summarize({ patientId: PATIENT }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_AI_PROMPT_SECRET',
    });
    expect(seen.length).toBe(0);
  });
});

describe('the declared redactor is the last thing to touch a prompt', () => {
  test('with none installed the prompt is unchanged, and the runtime still answers one', () => {
    expect(typeof aiRedactor()).toBe('function');
    expect(aiRedactor()('untouched')).toBe('untouched');
  });

  test('it rewrites the rendered prompt AND the system prompt before either is sent', async () => {
    const { provider, seen } = recorder();
    configureAi({
      gateway: createGateway({ providers: [provider] }),
      redact: (text) => text.replaceAll('clinical', '[removed]').replaceAll(PATIENT, '[removed]'),
    });
    const summarize = llm({
      input: Input,
      output: Output,
      prompt: promptFor('Summarise the note for {{patientId}}.'),
      vars: ({ input }) => ({ patientId: input.patientId }),
      policy: allow(),
    }).named('redactedVars');

    await summarize({ patientId: PATIENT }, { ctx: anonymousCtx() });
    const sent = seen[0];
    expect(sent?.messages[0]?.content).not.toContain(PATIENT);
    expect(sent?.messages[0]?.content).toContain('[removed]');
    // The system prompt is half of what the model reads, so a seam that skipped it is not one.
    expect(sent?.system).toBe('You are a [removed] summariser for a hospital.');
  });
});
