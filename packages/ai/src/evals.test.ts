import { afterEach, describe, expect, test } from 'bun:test';
import {
  contains,
  defineEval,
  exact,
  jsonSchemaValid,
  numericTolerance,
  resetEvals,
} from './evals';
import { createGateway } from './gateway';
import { definePrompt, resetPrompts } from './prompt';
import { EchoProvider } from './provider';

afterEach(() => {
  resetPrompts();
  resetEvals();
});

/** Answers keyed by the rendered prompt — a fixture, so the eval is a real test. */
function gatewayWith(replies: Record<string, string>) {
  return createGateway({ providers: [new EchoProvider({ replies })] });
}

const classify = () =>
  definePrompt<{ text: string }>({
    id: 'classify-sentiment',
    version: '1.0.0',
    template: 'Classify: {{text}}',
  });

describe('an eval is a test that fails CI', () => {
  test('assert throws X_EVAL_THRESHOLD naming the worst cases', async () => {
    const prompt = classify();
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'positive', // wrong
      'Classify: it broke': 'positive', // wrong
    });

    const evaluation = defineEval({
      name: 'sentiment',
      prompt,
      threshold: 0.9,
      scorers: [exact],
      cases: [
        { name: 'good', vars: { text: 'great product' }, expected: 'positive' },
        { name: 'bad', vars: { text: 'awful product' }, expected: 'negative' },
        { name: 'broken', vars: { text: 'it broke' }, expected: 'negative' },
      ],
    });

    let thrown: { code?: unknown; cause?: unknown; fix?: unknown } | undefined;
    try {
      await evaluation.assert(gateway);
    } catch (error) {
      thrown = error as { code?: unknown; cause?: unknown; fix?: unknown };
    }

    expect(thrown?.code).toBe('X_EVAL_THRESHOLD');
    const cause = String(thrown?.cause);
    // A useful failure names the score, the bar, the exact prompt, and what regressed.
    expect(cause).toContain('0.333');
    expect(cause).toContain('0.900');
    expect(cause).toContain(prompt.hash);
    expect(cause).toContain('bad=0.00');
    expect(String(thrown?.fix)).toContain('sentiment');
  });

  test('a passing eval returns the score attributed to the prompt hash', async () => {
    const prompt = classify();
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'negative',
    });
    const evaluation = defineEval({
      name: 'sentiment-ok',
      prompt,
      threshold: 1,
      scorers: [exact],
      cases: [
        { name: 'good', vars: { text: 'great product' }, expected: 'positive' },
        { name: 'bad', vars: { text: 'awful product' }, expected: 'negative' },
      ],
    });
    const result = await evaluation.assert(gateway);
    expect(result.score).toBe(1);
    expect(result.promptHash).toBe(prompt.hash);
    expect(result.promptRef).toBe('classify-sentiment@1.0.0');
  });
});

describe('built-in scorers', () => {
  test('contains is case-insensitive; exact is not forgiving', () => {
    expect(contains.score({ output: 'The Answer is 42.', expected: 'answer' })).toBe(1);
    expect(exact.score({ output: ' 42 ', expected: '42' })).toBe(1);
    expect(exact.score({ output: 'forty two', expected: '42' })).toBe(0);
  });

  test('json-schema-valid grades partial structure rather than pass/fail', () => {
    const scorer = jsonSchemaValid(['id', 'name']);
    expect(scorer.score({ output: '{"id":"1","name":"a"}' })).toBe(1);
    expect(scorer.score({ output: '{"id":"1"}' })).toBe(0.5);
    expect(scorer.score({ output: 'not json' })).toBe(0);
  });

  test('numeric tolerance degrades linearly to the tolerance edge', () => {
    const scorer = numericTolerance(10);
    expect(scorer.score({ output: '100', expected: '100' })).toBe(1);
    expect(scorer.score({ output: '105', expected: '100' })).toBe(0.5);
    expect(scorer.score({ output: '120', expected: '100' })).toBe(0);
  });
});
