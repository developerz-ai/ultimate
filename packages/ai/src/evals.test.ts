import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalBaseline } from './eval-baseline';
import { RECORD_ENV, writeBaseline } from './eval-baseline';
import { defineEval, describeEvals, promptsWithoutEvals, resetEvals } from './evals';
import { createGateway } from './gateway';
import { definePrompt, resetPrompts } from './prompt';
import type { GenerateRequest, Provider } from './provider';
import { EchoProvider } from './provider';
import type { Scorer } from './scorers';
import { exact } from './scorers';

const temporary: string[] = [];

afterEach(async () => {
  resetPrompts();
  resetEvals();
  delete Bun.env[RECORD_ENV];
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

/** A recorded baseline on disk, returned as the `import.meta.resolve`-shaped spec a declaration uses. */
async function recorded(baseline: EvalBaseline): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-eval-'));
  temporary.push(dir);
  const path = join(dir, `${baseline.eval}.baseline.json`);
  await writeBaseline(path, baseline);
  return path;
}

const unrecorded = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-eval-'));
  temporary.push(dir);
  return join(dir, 'never-recorded.baseline.json');
};

const THREE_CASES = [
  { name: 'good', vars: { text: 'great product' }, expected: 'positive' },
  { name: 'bad', vars: { text: 'awful product' }, expected: 'negative' },
  { name: 'broken', vars: { text: 'it broke' }, expected: 'negative' },
];

describe('unit · the gate is the drop, not the absolute score', () => {
  test('assert throws X_EVAL_THRESHOLD naming the case and both its scores', async () => {
    const prompt = classify();
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'positive', // regressed
      'Classify: it broke': 'negative',
    });
    const baseline = await recorded({
      eval: 'sentiment',
      prompt: 'classify-sentiment@0.9.0',
      promptHash: 'older',
      score: 1,
      cases: { good: 1, bad: 1, broken: 1 },
    });

    const evaluation = defineEval({
      name: 'sentiment',
      prompt,
      baseline,
      tolerance: 0.05,
      scorers: [exact],
      cases: THREE_CASES,
    });

    let thrown: { code?: unknown; cause?: unknown; fix?: unknown } | undefined;
    try {
      await evaluation.assert(gateway);
    } catch (error) {
      thrown = error as { code?: unknown; cause?: unknown; fix?: unknown };
    }

    expect(thrown?.code).toBe('X_EVAL_THRESHOLD');
    const cause = String(thrown?.cause);
    // A useful failure names the score, what it fell from, the exact prompt, and which case.
    expect(cause).toContain('0.667');
    expect(cause).toContain('1.000');
    expect(cause).toContain(prompt.hash);
    expect(cause).toContain('bad 0.00 ← 1.00');
    // Accepting a new number must be a reviewable diff, so the fix names the record command.
    expect(String(thrown?.fix)).toContain('ULTIMATE_EVAL_RECORD=1');
  });

  test('a low score that matches its baseline passes — an absolute floor would not', async () => {
    const prompt = classify();
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'positive',
      'Classify: it broke': 'positive',
    });
    const evaluation = defineEval({
      name: 'sentiment-flat',
      prompt,
      baseline: await recorded({
        eval: 'sentiment-flat',
        prompt: 'classify-sentiment@1.0.0',
        promptHash: prompt.hash,
        score: 0.333,
        cases: { good: 1, bad: 0, broken: 0 },
      }),
      tolerance: 0.05,
      scorers: [exact],
      cases: THREE_CASES,
    });

    const result = await evaluation.assert(gateway);
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.baseline).toBe(0.333);
  });

  test('a case that collapses fails even while the run mean holds', async () => {
    const prompt = classify();
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'positive', // was right
      'Classify: it broke': 'negative', // was wrong
    });
    const evaluation = defineEval({
      name: 'sentiment-swap',
      prompt,
      baseline: await recorded({
        eval: 'sentiment-swap',
        prompt: 'classify-sentiment@1.0.0',
        promptHash: prompt.hash,
        score: 0.667,
        cases: { good: 1, bad: 1, broken: 0 },
      }),
      tolerance: 0.05,
      scorers: [exact],
      cases: THREE_CASES,
    });

    const result = await evaluation.run(gateway);
    expect(result.score).toBeCloseTo(result.baseline ?? -1, 3);
    expect(result.regressions).toEqual([{ case: 'bad', baseline: 1, score: 0 }]);
    expect(result.passed).toBe(false);
    await expect(evaluation.assert(gateway)).rejects.toMatchObject({ code: 'X_EVAL_THRESHOLD' });
  });
});

// The scorer is an APP's function, so its arithmetic is not the framework's to trust. A `NaN`
// escaping `clampScore` propagated through `mean()` into `EvalResult.score`, and every comparison
// in `regressionsAgainst` is false for `NaN` — so the gate reported `passed: true` over a run that
// measured nothing, which is the one outcome an eval exists to prevent.
describe('unit · a scorer that answers NaN cannot report a pass', () => {
  /** The ordinary trigger: a ratio whose denominator a case is allowed to make zero. */
  const ratio: Scorer = {
    name: 'length-ratio',
    score: ({ output, expected }) => output.length / (expected ?? '').length,
  };

  test('a non-finite case score fails against a recorded baseline', async () => {
    const prompt = classify();
    // The model answered nothing for a case that declares no `expected` — 0 / 0.
    const gateway = gatewayWith({ 'Classify: great product': '' });
    const baseline = await recorded({
      eval: 'ratio',
      prompt: 'classify-sentiment@1.0.0',
      promptHash: 'older',
      score: 0.95,
      cases: { nameless: 0.95 },
    });

    const evaluation = defineEval({
      name: 'ratio',
      prompt,
      baseline,
      tolerance: 0.05,
      scorers: [ratio],
      // No `expected`, so the scorer divides by zero.
      cases: [{ name: 'nameless', vars: { text: 'great product' } }],
    });

    const result = await evaluation.run(gateway);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.passed).toBe(false);
    // Both halves of the gate see it: the run mean and the case itself.
    expect(result.regressions.map((r) => r.case).sort()).toEqual(['nameless', 'overall']);

    let thrown: { code?: unknown } | undefined;
    try {
      await evaluation.assert(gateway);
    } catch (error) {
      thrown = error as { code?: unknown };
    }
    expect(thrown?.code).toBe('X_EVAL_THRESHOLD');
  });
});

// The baseline is filed under the prompt's content hash, and `contentHash` covers `thinking`. An
// eval that does not SEND it measures a configuration the hash does not describe.
describe('unit · the eval sends the whole prompt configuration', () => {
  test('effort and thinking both reach the provider', async () => {
    const prompt = definePrompt<{ text: string }>({
      id: 'thinking-prompt',
      version: '1.0.0',
      template: 'Classify: {{text}}',
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

    const evaluation = defineEval({
      name: 'thinking',
      prompt,
      baseline: await unrecorded(),
      tolerance: 0.05,
      scorers: [exact],
      cases: [{ name: 'one', vars: { text: 'great' }, expected: 'Classify: great' }],
    });
    await evaluation.run(createGateway({ providers: [recording] }));

    expect(seen.length).toBe(1);
    expect(seen[0]?.effort).toBe('low');
    expect(seen[0]?.thinking).toBe('disabled');
  });
});

describe('unit · a baseline is a committed artifact', () => {
  test('an eval that has never been recorded fails instead of passing on nothing', async () => {
    const prompt = classify();
    const evaluation = defineEval({
      name: 'sentiment-new',
      prompt,
      baseline: await unrecorded(),
      tolerance: 0.05,
      scorers: [exact],
      cases: [THREE_CASES[0] ?? { name: 'good', vars: { text: 'x' } }],
    });
    const gateway = gatewayWith({ 'Classify: great product': 'positive' });

    const result = await evaluation.run(gateway);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(false); // a perfect score still gates on nothing
    await expect(evaluation.assert(gateway)).rejects.toMatchObject({
      code: 'X_EVAL_BASELINE_MISSING',
    });
  });

  test('record mode writes the scores with the prompt that produced them', async () => {
    const prompt = classify();
    const path = await unrecorded();
    const evaluation = defineEval({
      name: 'sentiment-record',
      prompt,
      baseline: path,
      tolerance: 0.05,
      scorers: [exact],
      cases: THREE_CASES,
    });
    const gateway = gatewayWith({
      'Classify: great product': 'positive',
      'Classify: awful product': 'negative',
      'Classify: it broke': 'positive',
    });

    Bun.env[RECORD_ENV] = '1';
    const result = await evaluation.assert(gateway);
    expect(result.passed).toBe(true);

    const written = (await Bun.file(path).json()) as EvalBaseline;
    expect(written).toEqual({
      eval: 'sentiment-record',
      prompt: 'classify-sentiment@1.0.0',
      promptHash: prompt.hash,
      score: 0.667,
      cases: { bad: 1, broken: 0, good: 1 },
    });
  });
});

describe('unit · every prompt is evaluated', () => {
  test('a prompt no eval names is reported; a version bump stays covered', async () => {
    const v1 = classify();
    definePrompt({ id: 'draft-reply', version: '2.0.0', template: 'Reply to {{text}}' });
    expect(promptsWithoutEvals().map((prompt) => prompt.ref)).toEqual([
      'classify-sentiment@1.0.0',
      'draft-reply@2.0.0',
    ]);

    defineEval({
      name: 'sentiment-cover',
      prompt: v1,
      baseline: await unrecorded(),
      tolerance: 0.05,
      scorers: [exact],
      cases: THREE_CASES,
    });
    // v2 of the same prompt id is the same lineage: the eval declared on it covers both.
    definePrompt<{ text: string }>({
      id: 'classify-sentiment',
      version: '2.0.0',
      template: 'Classify carefully: {{text}}',
    });

    expect(promptsWithoutEvals().map((prompt) => prompt.ref)).toEqual(['draft-reply@2.0.0']);
    expect(describeEvals()).toEqual([
      {
        name: 'sentiment-cover',
        prompt: 'classify-sentiment@1.0.0',
        promptId: 'classify-sentiment',
        tolerance: 0.05,
        baseline: expect.stringContaining('never-recorded.baseline.json'),
      },
    ]);
  });
});
