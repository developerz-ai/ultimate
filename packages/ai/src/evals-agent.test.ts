import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import { resetAgents } from './agent-facts';
import {
  actorsSeen,
  baselineFile,
  declareSupport,
  realRuns,
  removeBaselineDirs,
  scripted,
} from './eval-agent-fixture';
import { defineEval, describeEvals, promptsWithoutEvals, resetEvals } from './evals';
import { useFixtureModels } from './model-fixture';
import { definePrompt, resetPrompts } from './prompt';
import { calledTool, contains } from './scorers';

useFixtureModels();

afterEach(async () => {
  resetEvals();
  resetPrompts();
  resetAgents();
  resetActions();
  await removeBaselineDirs();
});

const LOOKUP = { call: 'lookupOrder', input: { id: 'o-1' } };
const ANSWER = { answer: { status: 'shipped' } };

async function supportEval(
  recorded: { score: number; cases: Record<string, number> } | undefined,
  cases = [
    { name: 'where-is-my-order', input: { question: 'Where is o-1?' }, expected: 'shipped' },
  ],
) {
  const { support, prompt } = declareSupport();
  const file = await baselineFile(
    recorded === undefined
      ? undefined
      : { eval: 'support', prompt: prompt.ref, promptHash: prompt.hash, ...recorded },
  );
  const evaluation = defineEval({
    name: 'support',
    agent: support,
    cases,
    tools: { lookupOrder: () => ({ id: 'o-1', status: 'shipped' }) },
    scorers: [calledTool('lookupOrder'), contains],
    baseline: file.path,
    tolerance: 0.05,
  });
  return { evaluation, prompt };
}

describe('unit · an agent eval runs the loop it measures', () => {
  test('a two-turn case scores through calledTool, and the request offered the tools', async () => {
    const { evaluation, prompt } = await supportEval({
      score: 1,
      cases: { 'where-is-my-order': 1 },
    });
    const { gateway, provider } = scripted(LOOKUP, ANSWER);

    const result = await evaluation.assert(gateway);

    expect(result.passed).toBe(true);
    expect(result.agent).toBe('supportAgent');
    expect(result.promptHash).toBe(prompt.hash);
    expect(result.cases).toEqual([
      {
        case: 'where-is-my-order',
        output: JSON.stringify({ status: 'shipped' }),
        score: 1,
        perScorer: { 'called-tool:lookupOrder': 1, contains: 1 },
        run: { turns: 2, toolCalls: ['lookupOrder'] },
      },
    ]);
    // The defect this arm exists for: the request carries the agent's tools.
    expect(provider.seen[0]?.tools?.map((tool) => tool.name)).toEqual([
      'lookupOrder',
      'refundOrder',
      'respond',
    ]);
    // The double answered: the model read it back on the second turn.
    expect(JSON.stringify(provider.seen[1]?.messages)).toContain('"status\\":\\"shipped');
    expect(realRuns).toEqual({ lookupOrder: 0, refundOrder: 0 });
  });

  test('an answer without the tool scores 0 on calledTool', async () => {
    const { evaluation } = await supportEval(undefined);
    const result = await evaluation.run(scripted(ANSWER).gateway);
    expect(result.cases[0]?.perScorer['called-tool:lookupOrder']).toBe(0);
    expect(result.cases[0]?.run).toEqual({ turns: 1, toolCalls: [] });
  });

  test('a call to a tool with no double is X_EVAL_TOOL_UNDOUBLED, and the real tool never ran', async () => {
    const { evaluation } = await supportEval(undefined);
    const { gateway } = scripted({ call: 'refundOrder', input: { id: 'o-1' } }, ANSWER);

    const thrown = await evaluation.run(gateway).then(
      () => expect.unreachable('an undoubled tool call must end the eval'),
      (error: unknown) => error as { code?: string; cause?: string; fix?: string },
    );

    expect(thrown.code).toBe('X_EVAL_TOOL_UNDOUBLED');
    expect(thrown.cause).toContain('refundOrder');
    expect(thrown.fix).toContain('refundOrder');
    expect(realRuns.refundOrder).toBe(0);
  });

  test('X_AGENT_MAX_TURNS scores that case 0, records the code, and the suite finishes', async () => {
    const { support } = declareSupport(2);
    const file = await baselineFile(undefined);
    const evaluation = defineEval({
      name: 'support',
      agent: support,
      cases: [
        { name: 'loops', input: { question: 'a' }, expected: 'shipped' },
        { name: 'answers', input: { question: 'b' }, expected: 'shipped' },
      ],
      tools: { lookupOrder: (input) => ({ ...input, status: 'shipped' }) },
      scorers: [contains],
      baseline: file.path,
      tolerance: 0,
    });
    const { gateway } = scripted(LOOKUP, { call: 'lookupOrder', input: { id: 'o-2' } }, ANSWER);

    const result = await evaluation.run(gateway);

    expect(result.cases.map((c) => [c.case, c.score, c.failed])).toEqual([
      ['loops', 0, 'X_AGENT_MAX_TURNS'],
      ['answers', 1, undefined],
    ]);
    expect(result.score).toBe(0.5);
  });

  test('a score that fell past the tolerance fails assert with X_EVAL_THRESHOLD', async () => {
    const { evaluation } = await supportEval({ score: 1, cases: { 'where-is-my-order': 1 } });
    // The prompt edit that regressed: the agent stopped looking the order up.
    const thrown = await evaluation.assert(scripted(ANSWER).gateway).then(
      () => expect.unreachable('a regression must fail the gate'),
      (error: unknown) => error as { code?: string; cause?: string },
    );
    expect(thrown.code).toBe('X_EVAL_THRESHOLD');
    expect(thrown.cause).toContain('where-is-my-order');
  });

  test('each case runs as the declared actor, or the eval service actor', async () => {
    const { support } = declareSupport();
    const file = await baselineFile(undefined);
    const base = {
      agent: support,
      cases: [{ name: 'one', input: { question: 'q' } }],
      tools: {},
      scorers: [contains],
      baseline: file.path,
      tolerance: 0,
    };

    await defineEval({ name: 'as-service', ...base }).run(scripted(ANSWER).gateway);
    await defineEval({ name: 'as-ada', ...base, actor: userActor({ id: 'ada' }) }).run(
      scripted(ANSWER).gateway,
    );

    expect(actorsSeen).toEqual(['service:eval', 'user:ada']);
  });
});

describe('unit · coverage and the report', () => {
  test("an agent eval covers the agent's prompt, and its fact names the agent", async () => {
    definePrompt({ id: 'uncovered', version: '1', template: 'x' });
    await supportEval(undefined);

    expect(promptsWithoutEvals().map((prompt) => prompt.ref)).toEqual(['uncovered@1']);
    expect(describeEvals().map((fact) => [fact.name, fact.prompt, fact.agent])).toEqual([
      ['support', 'support.answer@1', 'supportAgent'],
    ]);
  });

  test('an action agent() did not build is refused at declaration', () => {
    const { support } = declareSupport();
    const twin = support.named('twin');
    expect(() =>
      defineEval({
        name: 'twin',
        agent: twin,
        cases: [],
        tools: {},
        scorers: [],
        baseline: '/tmp/never.json',
        tolerance: 0,
      }),
    ).toThrow(/prompt is not registered/);
  });
});
