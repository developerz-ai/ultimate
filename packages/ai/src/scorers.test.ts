import { afterEach, describe, expect, test } from 'bun:test';
import { asyncRefusal } from './bounds-fixture';
import { createGateway } from './gateway';
import { definePrompt, resetPrompts } from './prompt';
import type { GenerateRequest, Provider } from './provider';
import { EchoProvider } from './provider';
import {
  clampScore,
  contains,
  exact,
  jsonSchemaValid,
  jsonValid,
  llmJudge,
  numericTolerance,
} from './scorers';

afterEach(() => {
  resetPrompts();
});

describe('unit · built-in scorers', () => {
  test('contains is case-insensitive; exact is not forgiving', () => {
    expect(contains.score({ output: 'The Answer is 42.', expected: 'answer' })).toBe(1);
    expect(exact.score({ output: ' 42 ', expected: '42' })).toBe(1);
    expect(exact.score({ output: 'forty two', expected: '42' })).toBe(0);
  });

  test('json-valid separates parseable output from prose about JSON', () => {
    expect(jsonValid.score({ output: '{"a":1}' })).toBe(1);
    expect(jsonValid.score({ output: 'Here is your JSON: {"a":1}' })).toBe(0);
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

// `clampScore` is the last thing between an app's scorer and a recorded number, and every score
// in a run passes through it. A comparison against `NaN` is false in BOTH directions, so an
// unclamped `NaN` reaches `EvalResult.score`, `regressionsAgainst`'s `now < was - tolerance` is
// false for it, and `assert()` reports a pass over a run that measured nothing.
describe('unit · clampScore', () => {
  test('scores outside 0..1 are pulled to the edge', () => {
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(1.5)).toBe(1);
    expect(clampScore(0.25)).toBe(0.25);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(1)).toBe(1);
  });

  test('a non-finite score is zero, not a pass nobody measured', () => {
    // The trigger is ordinary: `output.length / expected.length` on a case with no `expected`.
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampScore(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(Number.isFinite(clampScore(0 / 0))).toBe(true);
  });
});

describe('unit · llm judge', () => {
  const judgePrompt = () =>
    definePrompt<{ output: string; expected: string }>({
      id: 'judge.rubric',
      version: '1',
      template: 'Score 0..1. Answer: {{output}}. Reference: {{expected}}.',
    });

  test('the judge prompt hash is part of the scorer name, so a judge edit is visible', () => {
    const judge = judgePrompt();
    const gateway = createGateway({ providers: [new EchoProvider()] });
    expect(llmJudge({ gateway, judge }).name).toBe(`llm-judge@${judge.hash}`);
  });

  test('a judge that answers anything but a number scores zero rather than guessing', async () => {
    const judge = judgePrompt();
    const rendered = (output: string) => judge.render({ output, expected: 'ref' });
    const gateway = createGateway({
      providers: [
        new EchoProvider({
          replies: { [rendered('good')]: '0.8', [rendered('vague')]: 'pretty good, I think' },
        }),
      ],
    });
    const scorer = llmJudge({ gateway, judge });

    expect(await scorer.score({ output: 'good', expected: 'ref' })).toBe(0.8);
    expect(await scorer.score({ output: 'vague', expected: 'ref' })).toBe(0);
  });

  test('the judge is called with the whole prompt configuration it was declared with', async () => {
    // The scorer's NAME is the judge prompt's content hash, and `contentHash` covers `effort` and
    // `thinking` — so a call that drops either measures with a judge the name does not describe.
    const judge = definePrompt<{ output: string; expected: string }>({
      id: 'judge.configured',
      version: '1',
      template: 'Score 0..1. Answer: {{output}}. Reference: {{expected}}.',
      effort: 'low',
      thinking: 'disabled',
    });
    const seen: GenerateRequest[] = [];
    const echo = new EchoProvider();
    const recording: Provider = {
      name: 'recording',
      get models() {
        return echo.models;
      },
      generate(request) {
        seen.push(request);
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };

    const scorer = llmJudge({ gateway: createGateway({ providers: [recording] }), judge });
    await scorer.score({ output: 'good', expected: 'ref' });

    expect(seen.length).toBe(1);
    expect(seen[0]?.effort).toBe('low');
    expect(seen[0]?.thinking).toBe('disabled');
  });
});

/**
 * A judge is a model call, so it carries the same completion ceiling — and the same failure. A
 * `NaN` `maxTokens` becomes the pre-flight estimate, passes every budget scope, and then writes
 * itself onto the ledger and the per-process store: the eval that was measuring quality turns off
 * the spend ceiling for everything that runs after it. Refused per score, because `llmJudge` takes
 * the number as a plain field and there is no earlier seam to hold it at.
 */
describe('the judge screens its completion ceiling', () => {
  test('a maxTokens that is not a count never reaches the gateway', async () => {
    const judge = definePrompt<{ output: string; expected: string }>({
      id: 'judge.bounded',
      version: '1',
      template: 'Score 0..1. Answer: {{output}}. Reference: {{expected}}.',
    });
    const gateway = createGateway({ providers: [new EchoProvider()] });
    const scorer = llmJudge({ gateway, judge, maxTokens: Number.NaN });
    const error = await asyncRefusal(() => scorer.score({ output: 'good', expected: 'ref' }));
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toContain('maxTokens');
    expect(error.fix).toContain('llmJudge');
  });

  test('an honest ceiling still scores — the non-vacuity half', async () => {
    const judge = definePrompt<{ output: string; expected: string }>({
      id: 'judge.bounded.ok',
      version: '1',
      template: 'Score 0..1. Answer: {{output}}. Reference: {{expected}}.',
    });
    const gateway = createGateway({
      providers: [
        new EchoProvider({
          replies: { [judge.render({ output: 'good', expected: 'ref' })]: '0.9' },
        }),
      ],
    });
    const scorer = llmJudge({ gateway, judge, maxTokens: 128 });
    expect(await scorer.score({ output: 'good', expected: 'ref' })).toBe(0.9);
  });
});
