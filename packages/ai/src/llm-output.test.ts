// Single responsibility: an `output` that is not an object, and the prose reader. A tool's
// `input_schema` must be an object, so `output: t.string` projected `{"type":"string"}` straight
// into `respond` — a tool no model can call, two provider calls, then `X_LLM_OUTPUT_INVALID`. And
// the fence reader was a backtracking regex, quadratic on an unterminated fence.

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { llm } from './llm';
import { install, stub } from './llm-fixture';
import { definePrompt } from './prompt';
import { parseJsonish, respondFor } from './respond';
import { resetAiRuntime } from './runtime';

beforeEach(() => {
  resetAiRuntime();
});

let seq = 0;
const prompt = () => {
  seq += 1;
  return definePrompt<{ q: string }>({ id: `output-${seq}`, version: '1.0.0', template: '{{q}}' });
};

describe('a non-object output is wrapped in { value } and unwrapped', () => {
  test('respond carries an object schema around the declared one', () => {
    const { tool } = respondFor(t.string);
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    });
    // An object output is sent as it always was — no envelope.
    expect(respondFor(t.object({ a: t.string })).tool.input_schema.properties).toHaveProperty('a');
  });

  const base = {
    input: t.object({ q: t.string }),
    vars: ({ input }: { readonly input: { readonly q: string } }) => ({ q: input.q }),
    policy: allow(),
  };

  test('llm() with a string, a number or an array output answers in one call', async () => {
    const { provider, seen } = stub({ value: 'hello' }, { value: 42 }, { value: ['a', 'b'] });
    install(provider);
    const ctx = { ctx: anonymousCtx() };
    const text = llm({ ...base, output: t.string, prompt: prompt() }).named('wrappedString');
    const count = llm({ ...base, output: t.number, prompt: prompt() }).named('wrappedNumber');
    const list = llm({ ...base, output: t.array(t.string), prompt: prompt() }).named('wrappedList');
    expect(await text({ q: 'x' }, ctx)).toBe('hello');
    expect(await count({ q: 'x' }, ctx)).toBe(42);
    expect(await list({ q: 'x' }, ctx)).toEqual(['a', 'b']);
    // One provider call per declaration — no repair turn — and every tool an object.
    expect(seen.length).toBe(3);
    for (const request of seen) expect(request.tools?.[0]?.input_schema.type).toBe('object');
  });

  test('agent() unwraps the same envelope', async () => {
    const { provider } = stub({ value: 'done' });
    install(provider);
    const run = agent({
      input: t.object({ q: t.string }),
      output: t.string,
      prompt: prompt(),
      vars: ({ input }) => ({ q: input.q }),
      tools: [],
      policy: allow(),
    }).named('wrappedAgent');
    expect(await run({ q: 'x' }, { ctx: anonymousCtx() })).toBe('done');
  });

  test('a prose answer to a string output is the string itself', async () => {
    const { provider } = stub('just prose');
    install(provider);
    const ask = llm({
      input: t.object({ q: t.string }),
      output: t.string,
      prompt: prompt(),
      vars: ({ input }) => ({ q: input.q }),
      policy: allow(),
    }).named('proseString');
    expect(await ask({ q: 'x' }, { ctx: anonymousCtx() })).toBe('just prose');
  });
});

describe('parseJsonish', () => {
  test('a fenced block, a json-tagged one, and bare JSON all parse', () => {
    expect(parseJsonish('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonish('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(parseJsonish('  {"a":2}  ')).toEqual({ a: 2 });
    expect(parseJsonish('no json here')).toBeUndefined();
  });

  test('an unterminated fence reads the text, and does not backtrack over it', () => {
    expect(parseJsonish('```json\n{"a":3}')).toBeUndefined();
    // 1 MB of whitespace after an open fence. The old pattern re-scanned the tail from every
    // position — measured 0.9 s at 32k chars, so this input was hours; a single forward scan is
    // one pass. No duration is asserted: a regression does not finish.
    const hostile = `\`\`\`${' '.repeat(1_000_000)}`;
    expect(parseJsonish(hostile)).toBeUndefined();
    expect(parseJsonish(`\`\`\`${' \n'.repeat(500_000)}\`\`\``)).toBeUndefined();
  });
});
