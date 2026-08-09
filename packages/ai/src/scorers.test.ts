import { afterEach, describe, expect, test } from 'bun:test';
import { createGateway } from './gateway';
import { definePrompt, resetPrompts } from './prompt';
import { EchoProvider } from './provider';
import { contains, exact, jsonSchemaValid, jsonValid, llmJudge, numericTolerance } from './scorers';

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
});
