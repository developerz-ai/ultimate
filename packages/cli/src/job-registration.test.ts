// The `manifest` step's job half: a positional `anonymous-job-N` is a job nothing handed to
// `defineApi`, and the name it carries is the one the queue and every trace will show.

import { describe, expect, test } from 'bun:test';
import {
  positionalNames,
  unmaintainedPartitionFindings,
  unregisteredJobFinding,
  unregisteredJobFindings,
} from './job-registration';

describe('unit · a job no defineApi call names is a finding', () => {
  test('only the positional names job() and task() mint are reported', () => {
    expect(
      positionalNames(['reindexPost', 'anonymous-job-2', 'anonymous-task-1', 'anonymous-jobber']),
    ).toEqual(['anonymous-job-2', 'anonymous-task-1']);
  });

  test('the finding names the file and the list to add it to', () => {
    const job = unregisteredJobFinding('anonymous-job-3');
    expect(job.code).toBe('X_JOB_UNREGISTERED');
    expect(job.fix).toContain('to jobs: [...] in apps/web/api/index.ts');
    expect(unregisteredJobFinding('anonymous-task-1').fix).toContain('to tasks: [...]');
  });

  test('a load that failed reports nothing here — the step that loaded it reports the load', async () => {
    const failed = async () => ({
      findings: [{ code: 'X_APP_LOAD_FAILED', cause: 'broken', fix: 'x verify --json' }],
    });
    expect(await unregisteredJobFindings('/nowhere', failed)).toEqual([]);
  });
});

// The partition half: an entity declaring `partitionBy` with no `partitions()` job registered never
// gets a partition created ahead — the first insert past the last migrated one fails in production.
const job = (name: string, schedule?: string) => ({
  name,
  ...(schedule === undefined ? {} : { schedule: { name: schedule } }),
});

describe('unit · a partitioned entity needs its maintenance job', () => {
  test('a partitioned table and no partitions() job is X_PARTITIONS_UNMAINTAINED', () => {
    const findings = unmaintainedPartitionFindings(['events'], [job('reindexPost')]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_PARTITIONS_UNMAINTAINED']);
    expect(findings[0]?.cause).toContain('events');
    expect(findings[0]?.fix).toContain('partitions()');
    expect(findings[0]?.at).toBe('apps/web/api/index.ts');
  });

  test('a registered partitions() job — under any name — clears it', () => {
    expect(
      unmaintainedPartitionFindings(['events'], [job('partitions', 'partitions.schedule')]),
    ).toEqual([]);
    expect(
      unmaintainedPartitionFindings(['events'], [job('ledgerParts', 'ledgerParts.schedule')]),
    ).toEqual([]);
  });

  test('a job carrying some other schedule is not one', () => {
    expect(
      unmaintainedPartitionFindings(['events'], [job('partitions', 'other.cron')]),
    ).toHaveLength(1);
  });

  test('no partitioned entity asks for nothing', () => {
    expect(unmaintainedPartitionFindings([], [])).toEqual([]);
  });
});
