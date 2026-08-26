import { afterEach, describe, expect, test } from 'bun:test';
import { traceId } from './ids';
import {
  alwaysOffSampler,
  alwaysOnSampler,
  defaultSampler,
  OTEL_SAMPLER_ARG_KEY,
  OTEL_SAMPLER_KEY,
  parentBasedRatioSampler,
  ratioSampler,
  resetDefaultSampler,
  samplerFromEnv,
} from './sampler';
import type { SpanContext } from './telemetry';

const parent = (traceFlags: number): SpanContext => ({
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags,
});

/** The trace id of the span being created — the one input a `traceidratio` decision may read. */
const TRACE_A = '0af7651916cd43dd0000000000000001';
/** Low 8 bytes = exactly half the 64-bit space, so it pins the comparison's boundary. */
const TRACE_HALF = '0af7651916cd43dd8000000000000000';

afterEach(() => {
  resetDefaultSampler();
});

describe('parentBasedRatioSampler', () => {
  test('does NOT sample when the upstream said it did not — the bug this exists for', () => {
    expect(parentBasedRatioSampler(1).shouldSample('handler', parent(0), {}, TRACE_A)).toBe(false);
  });

  test('honours a sampled parent even at ratio 0', () => {
    expect(parentBasedRatioSampler(0).shouldSample('handler', parent(1), {}, TRACE_A)).toBe(true);
  });

  test('applies the ratio only to a root span', () => {
    const half = parentBasedRatioSampler(0.5, () => 0.9);
    expect(half.shouldSample('root', undefined, {}, TRACE_A)).toBe(false);
    expect(
      parentBasedRatioSampler(0.5, () => 0.1).shouldSample('root', undefined, {}, TRACE_A),
    ).toBe(true);
  });
});

describe('ratioSampler', () => {
  test('ignores the parent — the non-parent-based OTel spellings', () => {
    expect(ratioSampler(0).shouldSample('handler', parent(1), {}, TRACE_A)).toBe(false);
    expect(ratioSampler(1).shouldSample('handler', parent(0), {}, TRACE_A)).toBe(true);
  });
});

describe('samplerFromEnv', () => {
  test('always_off silences a sampled parent', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_KEY]: 'always_off' });
    expect(sampler.shouldSample('handler', parent(1), {}, TRACE_A)).toBe(false);
  });

  test('reads the ratio from OTEL_TRACES_SAMPLER_ARG', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_ARG_KEY]: '0' });
    expect(sampler.shouldSample('root', undefined, {}, TRACE_A)).toBe(false);
  });

  test('an unparseable ratio keeps the traces rather than dropping them silently', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_ARG_KEY]: 'half' });
    expect(sampler.shouldSample('root', undefined, {}, TRACE_A)).toBe(true);
  });

  test('unset is parent-based always-on', () => {
    const sampler = samplerFromEnv({});
    expect(sampler.shouldSample('root', undefined, {}, TRACE_A)).toBe(true);
    expect(sampler.shouldSample('child', parent(0), {}, TRACE_A)).toBe(false);
  });

  test('always_on and always_off are the shipped constants, not new objects', () => {
    expect(samplerFromEnv({ [OTEL_SAMPLER_KEY]: 'ALWAYS_ON' })).toBe(alwaysOnSampler);
    expect(samplerFromEnv({ [OTEL_SAMPLER_KEY]: ' always_off ' })).toBe(alwaysOffSampler);
  });
});

describe('defaultSampler', () => {
  test('reads the env at first use, not at module scope', () => {
    const previous = process.env[OTEL_SAMPLER_KEY];
    process.env[OTEL_SAMPLER_KEY] = 'always_off';
    try {
      resetDefaultSampler();
      expect(defaultSampler().shouldSample('root', undefined, {}, TRACE_A)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[OTEL_SAMPLER_KEY];
      else process.env[OTEL_SAMPLER_KEY] = previous;
      resetDefaultSampler();
    }
  });
});

describe('ratioSampler is deterministic per trace id', () => {
  test('every span of one trace gets the SAME decision, whatever the roll says', () => {
    // A roll that alternates: the broken implementation re-rolls per span, so eight spans of one
    // trace came back as four sampled and four not — orphan children under an unexported root.
    let rolls = 0;
    const alternating = (): number => (rolls++ % 2 === 0 ? 0.1 : 0.9);
    const sampler = ratioSampler(0.5, alternating);
    const decisions = new Set(
      Array.from({ length: 8 }, () => sampler.shouldSample('span', undefined, {}, TRACE_A)),
    );
    expect(decisions.size).toBe(1);
  });

  test('two samplers with opposite rolls agree, because neither rolls', () => {
    expect(ratioSampler(0.5, () => 0).shouldSample('span', undefined, {}, TRACE_A)).toBe(
      ratioSampler(0.5, () => 1).shouldSample('span', undefined, {}, TRACE_A),
    );
  });

  test('the hash is the low 8 bytes against ratio * 2^64', () => {
    // 0x8000…0000 is exactly half the 64-bit space: out at 0.5 (strictly less), in just above it.
    expect(ratioSampler(0.5).shouldSample('span', undefined, {}, TRACE_HALF)).toBe(false);
    expect(ratioSampler(0.51).shouldSample('span', undefined, {}, TRACE_HALF)).toBe(true);
    expect(ratioSampler(0.0001).shouldSample('span', undefined, {}, TRACE_A)).toBe(true);
  });

  test('distinct trace ids still approximate the ratio', () => {
    const sampler = ratioSampler(0.25);
    const ids = Array.from({ length: 2000 }, () => traceId());
    const sampled = ids.filter((id) => sampler.shouldSample('span', undefined, {}, id)).length;
    expect(sampled).toBeGreaterThan(400);
    expect(sampled).toBeLessThan(600);
  });

  test('a trace id no hash can read falls back to the injected roll', () => {
    expect(ratioSampler(0.5, () => 0.1).shouldSample('span', undefined, {}, 'not-a-trace')).toBe(
      true,
    );
    expect(ratioSampler(0.5, () => 0.9).shouldSample('span', undefined, {}, 'not-a-trace')).toBe(
      false,
    );
  });
});
