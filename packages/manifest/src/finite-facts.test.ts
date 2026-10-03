// A manifest number JSON cannot write back as itself is refused at build. `NaN` hashed as `NaN`
// and was written as `null`, so a manifest built from it failed its own `verifyBuildId` and the
// committed file could never match the code (`s1-t4` low, `build.ts` / `emit.ts`).

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { FIXTURE } from './diff-fixtures';
import { manifestJson, verifyBuildId } from './emit';
import type { Manifest } from './schema';

const refusal = (sources: ManifestSources): unknown => {
  try {
    buildManifest(sources);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('a number JSON cannot round-trip is refused where the manifest is built', () => {
  const lcp = (value: number): ManifestSources => ({
    ...FIXTURE,
    routes: [{ url: '/posts', render: 'isr', budget: { js: '40kb', lcp: value } }],
  });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
    test(`${Object.is(value, -0) ? '-0' : String(value)} names the fact it sits at`, () => {
      const error = refusal(lcp(value));
      expect(isUltimateError(error) ? error.code : error).toBe('X_MANIFEST_FACT_INVALID');
      expect(isUltimateError(error) ? error.meta?.['path'] : undefined).toBe(
        'routes[0].budget.lcp',
      );
    });
  }

  test('at every depth and in every section, an array element included', () => {
    const job = FIXTURE.jobs?.[0];
    if (job === undefined) return expect.unreachable('the fixture carries a job');
    const deep: ManifestSources = {
      ...FIXTURE,
      jobs: [{ ...job, retry: { ...job.retry, attempts: Number.NaN } }],
      actions: [
        { ...(FIXTURE.actions?.[0] ?? expect.unreachable('an action')), input: [1, Number.NaN] },
      ],
    };
    const error = refusal(deep);
    expect(isUltimateError(error) ? error.meta?.['path'] : error).toBe('actions[0].input[1]');
  });

  test('a finite manifest still round-trips its own buildId through the written bytes', () => {
    const built = buildManifest(lcp(2000));
    const reread = JSON.parse(manifestJson(built)) as Manifest;
    expect(verifyBuildId(reread)).toBe(true);
  });
});
