import { afterEach, describe, expect, test } from 'bun:test';
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

afterEach(() => {
  resetDefaultSampler();
});

describe('parentBasedRatioSampler', () => {
  test('does NOT sample when the upstream said it did not — the bug this exists for', () => {
    expect(parentBasedRatioSampler(1).shouldSample('handler', parent(0), {})).toBe(false);
  });

  test('honours a sampled parent even at ratio 0', () => {
    expect(parentBasedRatioSampler(0).shouldSample('handler', parent(1), {})).toBe(true);
  });

  test('applies the ratio only to a root span', () => {
    const half = parentBasedRatioSampler(0.5, () => 0.9);
    expect(half.shouldSample('root', undefined, {})).toBe(false);
    expect(parentBasedRatioSampler(0.5, () => 0.1).shouldSample('root', undefined, {})).toBe(true);
  });
});

describe('ratioSampler', () => {
  test('ignores the parent — the non-parent-based OTel spellings', () => {
    expect(ratioSampler(0).shouldSample('handler', parent(1), {})).toBe(false);
    expect(ratioSampler(1).shouldSample('handler', parent(0), {})).toBe(true);
  });
});

describe('samplerFromEnv', () => {
  test('always_off silences a sampled parent', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_KEY]: 'always_off' });
    expect(sampler.shouldSample('handler', parent(1), {})).toBe(false);
  });

  test('reads the ratio from OTEL_TRACES_SAMPLER_ARG', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_ARG_KEY]: '0' });
    expect(sampler.shouldSample('root', undefined, {})).toBe(false);
  });

  test('an unparseable ratio keeps the traces rather than dropping them silently', () => {
    const sampler = samplerFromEnv({ [OTEL_SAMPLER_ARG_KEY]: 'half' });
    expect(sampler.shouldSample('root', undefined, {})).toBe(true);
  });

  test('unset is parent-based always-on', () => {
    const sampler = samplerFromEnv({});
    expect(sampler.shouldSample('root', undefined, {})).toBe(true);
    expect(sampler.shouldSample('child', parent(0), {})).toBe(false);
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
      expect(defaultSampler().shouldSample('root', undefined, {})).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[OTEL_SAMPLER_KEY];
      else process.env[OTEL_SAMPLER_KEY] = previous;
      resetDefaultSampler();
    }
  });
});
