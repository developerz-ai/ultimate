// Single responsibility: the sampling decision — the one lever between "tracing is on" and "the
// collector melts". Separate from `telemetry.ts` because the decision is a policy an app replaces,
// while span construction is not.

import { logger } from './logger';
import type { SpanAttributes, SpanContext } from './telemetry';

/**
 * The seam. `parent` is the inbound span context when there is one — an upstream that decided
 * "not sampled" has said so in `parent.traceFlags`, and a sampler that ignores it splits one
 * distributed trace into a sampled half and an unsampled half, which is worse than either.
 */
export interface Sampler {
  shouldSample(name: string, parent: SpanContext | undefined, attributes: SpanAttributes): boolean;
}

export const OTEL_SAMPLER_KEY = 'OTEL_TRACES_SAMPLER';
export const OTEL_SAMPLER_ARG_KEY = 'OTEL_TRACES_SAMPLER_ARG';

/** Unset means on, exactly as OTel's own `parentbased_always_on` default does. */
export const DEFAULT_SAMPLE_RATIO = 1;

export const alwaysOnSampler: Sampler = Object.freeze({
  shouldSample: (): boolean => true,
});

export const alwaysOffSampler: Sampler = Object.freeze({
  shouldSample: (): boolean => false,
});

function parentSampled(parent: SpanContext | undefined): boolean | undefined {
  return parent === undefined ? undefined : (parent.traceFlags & 1) === 1;
}

/**
 * Honour the parent, else sample a `ratio` fraction of new traces.
 *
 * `random()` rather than a hash of the trace id: this sampler only ever decides for a ROOT span —
 * a span with a parent takes the parent's bit verbatim — so there is no second service whose
 * independent decision has to agree with ours, which is the only thing trace-id hashing buys.
 * `random` is injectable so the ratio is a test and not a coin flip.
 */
export function parentBasedRatioSampler(
  ratio: number,
  random: () => number = Math.random,
): Sampler {
  return {
    shouldSample(_name, parent): boolean {
      const inherited = parentSampled(parent);
      if (inherited !== undefined) return inherited;
      if (ratio >= 1) return true;
      if (ratio <= 0) return false;
      return random() < ratio;
    },
  };
}

/** `always_off` / `always_on` without the parent-based prefix ignore the inbound decision. */
export function ratioSampler(ratio: number, random: () => number = Math.random): Sampler {
  return {
    shouldSample(): boolean {
      if (ratio >= 1) return true;
      if (ratio <= 0) return false;
      return random() < ratio;
    },
  };
}

function readRatio(raw: string | undefined, spelling: string): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAMPLE_RATIO;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    // Warn rather than throw: this is read at the first span, not at boot, and a process that
    // dies mid-request over a sampling typo has turned an observability misconfiguration into an
    // outage. Falling back to 1 keeps the traces — losing them silently is the worse failure.
    logger.warn('X_TELEMETRY_SAMPLER_ARG_INVALID', {
      cause: `${spelling}="${raw}" is not a ratio between 0 and 1; sampling every trace instead`,
      fix: `set ${spelling} to a value between 0 and 1, e.g. ${spelling}=0.05`,
    });
    return DEFAULT_SAMPLE_RATIO;
  }
  return parsed;
}

/**
 * The sampler the env asks for. Recognises the OTel spellings an operator already knows; anything
 * else falls through to parent-based ratio, which is the default behaviour either way.
 */
export function samplerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Sampler {
  const name = (env[OTEL_SAMPLER_KEY] ?? '').trim().toLowerCase();
  const ratio = readRatio(env[OTEL_SAMPLER_ARG_KEY], OTEL_SAMPLER_ARG_KEY);
  switch (name) {
    case 'always_off':
      return alwaysOffSampler;
    case 'always_on':
      return alwaysOnSampler;
    case 'traceidratio':
      return ratioSampler(ratio);
    case 'parentbased_always_off':
      return parentBasedRatioSampler(0);
    default:
      // `parentbased_always_on`, `parentbased_traceidratio` and the unset case are one sampler:
      // honour the parent, else the ratio — which is 1 when nothing set an arg.
      return parentBasedRatioSampler(ratio);
  }
}

let cached: Sampler | undefined;

/**
 * Read at the first span, never at module scope: `installSecrets()` and `defineEnv()` both land
 * values in `process.env` during boot, and a module-scope read would pin whatever was set before
 * the app configured itself — the same defect `cursor.ts` fixed by moving its secret read into
 * `sign()`.
 */
export function defaultSampler(): Sampler {
  if (cached === undefined) cached = samplerFromEnv();
  return cached;
}

/** Test-only: forget the env-derived sampler so the next read sees the current environment. */
export function resetDefaultSampler(): void {
  cached = undefined;
}
