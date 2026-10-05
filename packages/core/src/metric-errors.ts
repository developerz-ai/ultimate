// Single responsibility: the two coded refusals a metric VALUE or a series CEILING earns, and the
// finiteness screen every recording path runs first. The name grammar's refusal is
// `metric-names.ts`'s; `metrics.ts` re-exports all three, so callers keep one import path.

import { type CodedErrorInit, UltimateError } from './errors';

export class MetricValueInvalidError extends UltimateError {
  static readonly code = 'X_METRIC_VALUE_INVALID';
  override readonly name = 'MetricValueInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricValueInvalidError.code });
  }
}

export class MetricCardinalityError extends UltimateError {
  static readonly code = 'X_METRIC_CARDINALITY';
  override readonly name = 'MetricCardinalityError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricCardinalityError.code });
  }
}

export function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new MetricValueInvalidError({
      cause: `${name} was given ${String(value)}, which is not a finite number`,
      fix: `guard the value at the call site: Number.isFinite(v) before recording into ${name}`,
      meta: { metric: name, received: String(value) },
    });
  }
  return value;
}
