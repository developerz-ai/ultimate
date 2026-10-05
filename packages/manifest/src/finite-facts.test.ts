// A manifest number JSON cannot write back as itself is refused at build. `NaN` hashed as `NaN`
// and was written as `null`, so a manifest built from it failed its own `verifyBuildId` and the
// committed file could never match the code (`s1-t4` low, `build.ts` / `emit.ts`).

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { FIXTURE } from './diff-fixture';
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
  const attempts = (value: number): ManifestSources => {
    const job = FIXTURE.jobs?.[0] ?? expect.unreachable('the fixture carries a job');
    return { ...FIXTURE, jobs: [{ ...job, retry: { ...job.retry, attempts: value } }] };
  };

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
    test(`${Object.is(value, -0) ? '-0' : String(value)} names the fact it sits at`, () => {
      const error = refusal(attempts(value));
      expect(isUltimateError(error) ? error.code : error).toBe('X_MANIFEST_FACT_INVALID');
      expect(isUltimateError(error) ? error.meta?.['path'] : undefined).toBe(
        'jobs[0].retry.attempts',
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
    const built = buildManifest(attempts(3));
    const reread = JSON.parse(manifestJson(built)) as Manifest;
    expect(verifyBuildId(reread)).toBe(true);
  });
});
