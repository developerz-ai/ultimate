// The framework-schema gauges a serving role publishes from its stamp verdict: applied or not, and
// whether the newest applied build is another major — the two facts a rollout's alerts read.

import { describe, expect, test } from 'bun:test';
import { collectMetrics } from './metrics';
import { metricsText } from './metrics-text';
import { recordFrameworkSchema } from './schema-metrics';

const value = (name: string): number | undefined =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points[0]?.value;

describe('unit · the framework schema gauges', () => {
  test('an unapplied schema reads 0 applied, and a later verdict replaces it', () => {
    recordFrameworkSchema({ applied: false, majorSkew: false });
    expect([value('framework_schema_applied'), value('framework_schema_major_skew')]).toEqual([
      0, 0,
    ]);
    recordFrameworkSchema({ applied: true, majorSkew: true });
    expect([value('framework_schema_applied'), value('framework_schema_major_skew')]).toEqual([
      1, 1,
    ]);
  });

  test('both series reach the scrape body', () => {
    recordFrameworkSchema({ applied: true, majorSkew: false });
    const body = metricsText();
    expect(body).toContain('\nframework_schema_applied 1\n');
    expect(body).toContain('\nframework_schema_major_skew 0\n');
  });
});
