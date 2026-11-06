// Single responsibility: a dead job as a replay — what `inspectJob` and the run's step records say,
// folded into the `JobFailure` `reproJob` takes, and the `.job.test.ts` that replays it. Pure: the
// reads are `repro-bundle.ts`', the write is `repro-write.ts`'.

import type { ErrorReport } from '@ultimat3/core';
import { captureValue, errorFingerprint, singleLine } from '@ultimat3/core';
import type { JobTrace, StepRecord } from '@ultimat3/jobs';
import type { JobFailure } from '@ultimat3/testing';
import { tsLiteral } from './repro-literal';

const CODE = /X_[A-Z0-9_]+/;

/** `inspectJob`'s trace (input already masked as `x jobs show` masks it) plus the run's steps. */
export function jobFailureOf(trace: JobTrace, records: readonly StepRecord[]): JobFailure {
  const { value, masked } = captureValue(trace.input);
  return {
    jobId: trace.id,
    name: trace.name,
    input: value,
    masked,
    // Completed steps only, in the order the run took them: each one replays from its output.
    steps: records
      .filter((record) => record.status === 'completed')
      .map((record) => ({ name: record.name, output: record.output ?? null })),
    code: CODE.exec(trace.lastError ?? '')?.[0] ?? null,
    step: records.find((record) => record.status === 'failed')?.name ?? null,
  };
}

/** The group a job failure reports under — `source: 'job'`, the job's name as the operation. */
export function jobFingerprint(failure: JobFailure): string | null {
  if (failure.code === null) return null;
  const report: Pick<ErrorReport, 'code' | 'source' | 'scope'> = {
    code: failure.code,
    source: 'job',
    scope: { operation: failure.name },
  };
  // `errorFingerprint` reads three fields through total accessors; the rest of a report is not read.
  return errorFingerprint(report as ErrorReport);
}

export interface ReproSourceMeta {
  /** Bare id, as the user typed it — the comment says how the file came to be. */
  readonly id: string;
  /** Module specifiers imported for their registrations (the app's API index), relative. */
  readonly imports: readonly string[];
}

export const header = (lines: readonly string[]): string =>
  lines.map((line) => `// ${singleLine(line)}`).join('\n');

/** A `.job.test.ts` that is RED until the fault is fixed: the run must settle with no error. */
export function jobTestSource(failure: JobFailure, meta: ReproSourceMeta): string {
  const masked = failure.masked.length === 0 ? 'none' : failure.masked.join(', ');
  return `${header([
    `x repro ${meta.id}: job "${failure.name}" died with ${failure.code ?? 'an uncoded failure'} at step "${failure.step ?? '(the body)'}".`,
    'Written by `x repro --write`. Red until the fault is fixed: the completed steps replay from',
    `their stored output, then the job runs once more. Masked input fields (${masked}) are stood in`,
    'for from the schema — set them here when the failure needs their real shape.',
  ])}

import { expect, type JobFailure, jobTest, reproJob } from '@ultimat3/testing';
${meta.imports.map((specifier) => `import '${specifier}';`).join('\n')}

const FAILURE: JobFailure = ${tsLiteral(failure)};

jobTest(${tsLiteral(`repro ${meta.id.slice(0, 8)}: ${failure.name} settles`)}, async ({ runJobs }) => {
  const outcome = await reproJob(runJobs, FAILURE);
  expect(outcome.failure).toBeNull();
});
`;
}
