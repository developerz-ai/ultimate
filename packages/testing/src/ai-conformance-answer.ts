// What a well-formed model answer is, asserted the one way both AI suites need it: the provider's
// and the gateway's. A `GenerateResult` crosses into `llm()`, the budget ledger and the meter, so a
// float token count, a float `minor` or a refusal with no details is a defect three readers
// inherit.

import { expect } from 'bun:test';
import type { GenerateRequest, GenerateResult, StreamChunk } from '@ultimat3/ai';

const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
] as const;

/** A request every model answers: one short user turn, a small ceiling. */
export const askOf = (model: string, extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model,
  messages: [{ role: 'user', content: 'say hello world' }],
  maxTokens: 64,
  ...extra,
});

export function expectWellFormed(result: GenerateResult, model: string): void {
  expect(result.model).toBe(model);
  expect(typeof result.text).toBe('string');
  expect(Array.isArray(result.toolCalls)).toBe(true);
  for (const call of result.toolCalls) {
    expect(typeof call.id).toBe('string');
    expect(
      typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input),
    ).toBe(true);
  }
  expect(STOP_REASONS as readonly string[]).toContain(result.stopReason);
  // Required on a refusal, absent otherwise: it is the one field that says another model might
  // answer.
  if (result.stopReason === 'refusal') expect(result.stopDetails?.type).toBe('refusal');
  else expect(result.stopDetails).toBeUndefined();
  for (const count of Object.values(result.usage)) {
    expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
  }
  expect(Number.isSafeInteger(result.cost.minor) && result.cost.minor >= 0).toBe(true);
  expect(result.cost.currency).toMatch(/^[A-Z]{3}$/);
}

/** Every chunk a stream yields, in order. */
export async function drained(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
}

/** Exactly one `done`, last, well-formed — and the text deltas before it spell its text. */
export function expectStreamed(chunks: readonly StreamChunk[], model: string): GenerateResult {
  const done = chunks.filter((chunk) => chunk.type === 'done');
  expect(done).toHaveLength(1);
  const last = chunks.at(-1);
  if (last?.type !== 'done') return expect.unreachable('the stream did not end on its done chunk');
  expectWellFormed(last.result, model);
  const spelled = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : [])).join('');
  // Trailing whitespace aside: `echoProvider` streams one word per chunk, each with its space.
  expect(spelled.trimEnd()).toBe(last.result.text.trimEnd());
  return last.result;
}
