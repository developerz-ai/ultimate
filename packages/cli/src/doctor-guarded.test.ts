// A doctor check that throws is reported and the rest still run: the loop this replaces had the
// doctor's own crash telling the reader to run the doctor.

import { describe, expect, test } from 'bun:test';
import { reportDoctor, runDoctor } from './cmd-doctor';
import { codes, probe } from './cmd-doctor-fixture';

const CATALOG_ERROR = new SyntaxError("JSON Parse error: Unrecognized token '<'");
const throws = async (): Promise<never> => {
  throw CATALOG_ERROR;
};

describe('unit · runDoctor survives a check that throws', () => {
  test('the failure is a finding that never prescribes x doctor', async () => {
    const findings = await runDoctor(probe({ offlineFallback: throws }));
    const failed = findings.find((one) => one.code === 'X_DOCTOR_PROBE_FAILED');
    expect(failed?.cause).toContain('offline fallback');
    expect(failed?.cause).toContain('Unrecognized token');
    expect(failed?.fix).toBe('bunx x manifest --json');
  });

  test('the checks after it still report', async () => {
    const drift = { code: 'X_DB_DRIFT', cause: 'c', fix: 'f' };
    expect(await codes(probe({ offlineFallback: throws, drift: async () => [drift] }))).toEqual([
      'X_DOCTOR_PROBE_FAILED',
      'X_DB_DRIFT',
    ]);
  });

  test('what a merge left is reported first', async () => {
    const merge = { code: 'X_MERGE_UNRESOLVED', cause: 'c', fix: 'f' };
    const drift = { code: 'X_DB_DRIFT', cause: 'c', fix: 'f' };
    expect(
      await codes(probe({ mergeState: async () => [merge], drift: async () => [drift] })),
    ).toEqual(['X_MERGE_UNRESOLVED', 'X_DB_DRIFT']);
  });
});

describe('unit · reportDoctor', () => {
  test('a listing that throws is a warning and the verdict stands', async () => {
    const result = await reportDoctor(probe({ browser: throws }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain('X_DOCTOR_PROBE_FAILED');
  });

  test('a clone without the merge drivers is warned, not failed', async () => {
    const result = await reportDoctor(probe({ mergeDriverUnset: async () => true }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain('X_MERGE_DRIVER_UNSET');
    expect(JSON.stringify(result.data)).toContain('bunx x merge-driver install');
  });
});
