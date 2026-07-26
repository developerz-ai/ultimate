import { afterEach, describe, expect, test } from 'bun:test';
import { contentHash, definePrompt, getPrompt, resetPrompts } from './prompt';

afterEach(() => {
  resetPrompts();
});

const base = {
  id: 'summarize',
  version: '1.0.0',
  template: 'Summarize the following in {{sentences}} sentences:\n\n{{document}}',
};

describe('prompts are content-hashed artifacts', () => {
  test('the hash changes when the template changes', () => {
    const before = contentHash(base);
    const after = contentHash({ ...base, template: `${base.template}\nBe concise.` });
    expect(after).not.toBe(before);
    // ...and is stable for identical input, or two runs of the same eval are incomparable.
    expect(contentHash(base)).toBe(before);
  });

  test('the hash covers every field that changes model behaviour', () => {
    const original = contentHash(base);
    expect(contentHash({ ...base, system: 'You are terse.' })).not.toBe(original);
    expect(contentHash({ ...base, effort: 'low' })).not.toBe(original);
    expect(contentHash({ ...base, model: 'claude-haiku-4-5' })).not.toBe(original);
    expect(contentHash({ ...base, output: { type: 'object' } })).not.toBe(original);
  });

  test('schema key order does not change the hash', () => {
    const a = contentHash({
      ...base,
      output: { type: 'object', description: 'x', properties: { a: { type: 'string' } } },
    });
    const b = contentHash({
      ...base,
      output: { properties: { a: { type: 'string' } }, description: 'x', type: 'object' },
    });
    expect(a).toBe(b);
  });

  test('re-registering a version whose content moved is refused', () => {
    definePrompt<{ sentences: number; document: string }>(base);
    const thrown = capture(() =>
      definePrompt<{ sentences: number; document: string }>({
        ...base,
        template: 'Something else entirely: {{document}} {{sentences}}',
      }),
    );
    // Edit the template, bump the version — otherwise every recorded score is a lie.
    expect(thrown).toMatchObject({ code: 'X_AI_PROMPT_VERSION' });
  });
});

/** Return the thrown value so assertions can read `code`/`cause`, not just the message. */
function capture(fn: () => unknown): { code?: unknown; cause?: unknown } {
  try {
    fn();
  } catch (error) {
    return error as { code?: unknown; cause?: unknown };
  }
  throw new Error('expected the call to throw');
}

describe('rendering', () => {
  test('variables are substituted and the ref identifies the artifact', () => {
    const prompt = definePrompt<{ sentences: number; document: string }>(base);
    expect(prompt.ref).toBe('summarize@1.0.0');
    expect(prompt.render({ sentences: 2, document: 'Hello.' })).toBe(
      'Summarize the following in 2 sentences:\n\nHello.',
    );
  });

  test('a missing variable throws instead of rendering a blank', () => {
    const prompt = definePrompt<{ sentences: number; document: string }>(base);
    // A silently blank placeholder produces a prompt that reads fine and asks
    // something different — exactly the failure that never gets noticed.
    const thrown = capture(() =>
      (prompt.render as unknown as (vars: Record<string, string>) => string)({ document: 'Hi.' }),
    );
    expect(thrown.code).toBe('X_AI_PROMPT_VERSION');
    expect(String(thrown.cause)).toContain('sentences');
  });

  test('getPrompt lists available versions when the requested one is absent', () => {
    definePrompt<{ sentences: number; document: string }>(base);
    const thrown = capture(() => getPrompt('summarize', '2.0.0'));
    expect(String(thrown.cause)).toContain('1.0.0');
  });
});
