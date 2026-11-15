// Single responsibility: whether this process's build has its framework schema applied, and whether
// the newest applied build is another major — as two gauges, so a rollout that ran its roles before
// migrate, or a fleet left straddling a breaking release, raises an alert instead of a log line.

import type { Gauge } from './metrics';
import { gauge } from './metrics';

interface SchemaGauges {
  readonly applied: Gauge;
  readonly majorSkew: Gauge;
}

let declared: SchemaGauges | undefined;

/** On the first verdict, never at import: a process that verifies nothing declares no series. */
function gauges(): SchemaGauges {
  declared ??= {
    applied: gauge('framework_schema_applied', {
      unit: '1',
      description:
        "1 when this build's schema is applied: the framework stamp and every app migration it ships. 0 while a role waits for the migrate step",
    }),
    majorSkew: gauge('framework_schema_major_skew', {
      unit: '1',
      description: '1 when the newest applied framework schema is another major than this build',
    }),
  };
  return declared;
}

export interface FrameworkSchemaSample {
  readonly applied: boolean;
  readonly majorSkew: boolean;
}

/** One call per stamp verdict, from the serving role's framework-schema check. */
export function recordFrameworkSchema(sample: FrameworkSchemaSample): void {
  const g = gauges();
  g.applied.record(sample.applied ? 1 : 0);
  g.majorSkew.record(sample.majorSkew ? 1 : 0);
}
