// The semconv histograms are bus subscribers: a `db.statement`, `job.perform` or `ai.llm` event
// becomes a point with bounded labels, and nothing is recorded once unsubscribed.

import { afterEach, describe, expect, test } from 'bun:test';
import { InternalError } from './errors';
import { instrument, resetInstrumentation } from './instrument';
import { SEMCONV_METRICS } from './instrument-semconv';
import { collectMetrics, type HistogramPoint, resetMetrics } from './metrics';
import { dbOperationOf, subscribeSemconvMetrics } from './metrics-semconv';

afterEach(() => {
  resetInstrumentation();
  resetMetrics();
});

const pointsOf = (name: string): readonly HistogramPoint[] =>
  (collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ??
    []) as readonly HistogramPoint[];

describe('unit · subscribeSemconvMetrics', () => {
  test('a statement is a duration point in seconds, labelled by a bounded operation', () => {
    const off = subscribeSemconvMetrics();
    instrument('db.statement', {
      text: 'SELECT * FROM t WHERE id = $1',
      values: [1],
      rows: 1,
      durationMs: 250,
    });
    instrument('db.statement', {
      text: 'vacuum t',
      values: [],
      rows: 0,
      durationMs: 1000,
      error: new InternalError({ cause: 'gone', fix: 'look elsewhere' }),
    });
    off();
    instrument('db.statement', { text: 'select 1', values: [], rows: 1, durationMs: 9 });
    const points = pointsOf(SEMCONV_METRICS.dbClientOperationDuration);
    expect(points.map((point) => [point.attributes, point.value, point.count])).toEqual([
      [{ db_system_name: 'postgresql', db_operation_name: 'select' }, 0.25, 1],
      [
        { db_system_name: 'postgresql', db_operation_name: 'other', error_type: 'X_INTERNAL' },
        1,
        1,
      ],
    ]);
  });

  test('a job is a duration point by queue and outcome', () => {
    const off = subscribeSemconvMetrics();
    instrument('job.perform', {
      job: 'send',
      queue: 'mail',
      id: 'j1',
      attempt: 1,
      durationMs: 1500,
    });
    off();
    expect(pointsOf(SEMCONV_METRICS.jobDuration).map((p) => [p.attributes, p.value])).toEqual([
      [{ queue: 'mail', outcome: 'ok' }, 1.5],
    ]);
  });

  test('an LLM call is two token points, input and output', () => {
    const off = subscribeSemconvMetrics();
    instrument('ai.llm', {
      provider: 'anthropic',
      model: 'claude',
      inputTokens: 120,
      outputTokens: 30,
      cacheHit: false,
      durationMs: 800,
    });
    off();
    expect(
      pointsOf(SEMCONV_METRICS.genAiClientTokenUsage).map((p) => [
        p.attributes['gen_ai_token_type'],
        p.value,
      ]),
    ).toEqual([
      ['input', 120],
      ['output', 30],
    ]);
  });

  test('token points carry the required operation name; a cache hit records none', () => {
    const off = subscribeSemconvMetrics();
    const call = {
      provider: 'anthropic',
      model: 'claude',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
    };
    instrument('ai.llm', { ...call, cacheHit: true });
    instrument('ai.llm', { ...call, cacheHit: false });
    off();
    const points = pointsOf(SEMCONV_METRICS.genAiClientTokenUsage);
    expect(points.map((p) => [p.attributes['gen_ai_operation_name'], p.count])).toEqual([
      ['chat', 1],
      ['chat', 1],
    ]);
  });

  test('the operation label never carries statement text', () => {
    expect(dbOperationOf('  WITH x AS (select 1) select * from x')).toBe('with');
    expect(dbOperationOf('select_secret_fn()')).toBe('other');
    expect(dbOperationOf('')).toBe('other');
  });
});
