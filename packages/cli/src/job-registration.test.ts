// The `manifest` step's job half: a positional `anonymous-job-N` is a job nothing handed to
// `defineApi`, and the name it carries is the one the queue and every trace will show.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove API, and no path joiner.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronJob, job, partitions, resetJobs, resetTasks } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
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
    expect(job.fix).toContain('added to jobs: [...] there');
    expect(unregisteredJobFinding('anonymous-task-1').fix).toContain('added to tasks: [...]');
  });

  test('a job whose file is known gets that file, and an import line that pastes', () => {
    const finding = unregisteredJobFinding(
      'anonymous-job-4',
      'apps/web/app/post/jobs/nudge-post.ts',
    );
    expect(finding.at).toBe('apps/web/app/post/jobs/nudge-post.ts');
    expect(finding.cause).toContain('apps/web/app/post/jobs/nudge-post.ts');
    expect(finding.fix).toStartWith("import * as nudgePost from '../app/post/jobs/nudge-post';");
    expect(finding.fix).toContain('nudgePost added to jobs: [...] there');
    expect(finding.fix).not.toContain('<');
  });

  test('a module the index reaches through a package keeps a relative path that resolves', () => {
    expect(
      unregisteredJobFinding('anonymous-task-1', 'packages/ops/src/1-sweep.ts').fix,
    ).toStartWith("import * as module1Sweep from '../../../packages/ops/src/1-sweep';");
  });

  test('the step finds the file by the exported handle, in what the load imported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-registration-'));
    try {
      await Bun.write(
        join(dir, 'apps/web/app/post/jobs/nudge-post.ts'),
        `import { job } from ${JSON.stringify(import.meta.resolve('@ultimat3/jobs'))};
import { t } from ${JSON.stringify(import.meta.resolve('@ultimat3/schema'))};
export const nudge = job({ input: t.object({}), tenant: 'none', idempotencyKey: () => 'k', retry: { attempts: 1, backoff: 'exponential' }, async run() {} });
`,
      );
      await Bun.write(join(dir, 'apps/web/app/post/plain.ts'), 'export const plain = 1;\n');
      const files = ['apps/web/app/post/jobs/nudge-post.ts', 'apps/web/app/post/plain.ts'];
      for (const file of files) await import(join(dir, file));
      const [finding] = await unregisteredJobFindings(dir, async () => ({ findings: [], files }));
      expect(finding?.code).toBe('X_JOB_UNREGISTERED');
      expect(finding?.at).toBe('apps/web/app/post/jobs/nudge-post.ts');
    } finally {
      resetJobs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a job no module exports still says where the import goes', async () => {
    job({
      input: t.object({}),
      tenant: 'none',
      idempotencyKey: () => 'k',
      retry: { attempts: 1, backoff: 'exponential' },
      async run() {},
    });
    try {
      const [finding] = await unregisteredJobFindings('/nowhere', async () => ({
        findings: [],
        files: [],
      }));
      expect(finding?.at).toBe('apps/web/api/index.ts');
      expect(finding?.fix).toContain("from '<its file>'");
    } finally {
      resetJobs();
    }
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
const handle = (name: string, schedule?: string) => ({
  name,
  ...(schedule === undefined ? {} : { schedule: { name: schedule } }),
});

describe('unit · a partitioned entity needs its maintenance job', () => {
  afterEach(() => {
    resetJobs();
    resetTasks();
  });

  test('a partitioned table and no partitions() job is X_PARTITIONS_UNMAINTAINED', () => {
    const findings = unmaintainedPartitionFindings(['events'], [handle('reindexPost')]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_PARTITIONS_UNMAINTAINED']);
    expect(findings[0]?.cause).toContain('events');
    expect(findings[0]?.fix).toContain('partitions()');
    expect(findings[0]?.at).toBe('apps/web/api/index.ts');
  });

  test('a registered partitions() job — under any name — clears it', () => {
    expect(unmaintainedPartitionFindings(['events'], [partitions()])).toEqual([]);
    expect(
      unmaintainedPartitionFindings(['events'], [partitions({ name: 'ledgerParts' })]),
    ).toEqual([]);
  });

  test('a cronJob() carries the same <job>.schedule shape and maintains nothing', () => {
    const nightly = cronJob({
      name: 'nightlyReport',
      cron: '0 3 * * *',
      tz: 'UTC',
      tenant: 'none',
      retry: { attempts: 1 },
      run: async () => {},
    });
    expect(nightly.schedule.name).toBe('nightlyReport.schedule');
    expect(unmaintainedPartitionFindings(['events'], [nightly])).toHaveLength(1);
  });

  test('a look-alike shape is not one either: only what partitions() minted counts', () => {
    expect(
      unmaintainedPartitionFindings(['events'], [handle('partitions', 'partitions.schedule')]),
    ).toHaveLength(1);
  });

  test('no partitioned entity asks for nothing', () => {
    expect(unmaintainedPartitionFindings([], [])).toEqual([]);
  });
});
