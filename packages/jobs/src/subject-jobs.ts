// `subjectExport()` and `subjectErase()`: one person's data exported or erased, each a FACTORY over
// `job()`, never a ninth primitive. Both plan the subject when a run starts and refuse an untreated
// table before a row is touched. Who may call them is the app's action: no route, no MCP tool.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { registeredEntities } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { ExportFormat } from './export-format';
import type { ExportSink } from './export-sink';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { StepApi } from './steps-api';
import type { Subject } from './subject';
import type { SubjectEraseReport } from './subject-erase-pass';
import { subjectErasePass } from './subject-erase-pass';
import type { SubjectExportReport } from './subject-export-pass';
import { subjectExportPass } from './subject-export-pass';
import type { SubjectPlan } from './subject-plan';
import { planSubject } from './subject-plan';
import type { SubjectReader } from './subject-select';
import { subjectReader } from './subject-select';
import type { JobTenant } from './tenant';

export interface SubjectJobDefinition<I> {
  /** REQUIRED: a durable key, as on `exportRows()`. */
  readonly name: string;
  readonly input: StandardSchemaV1<unknown, I>;
  readonly subject: Subject<I>;
  /** A job per tenant: `(input) => input.orgId`. Crossing tenants is the app's own loop. */
  readonly tenant: JobTenant<I>;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
}

export interface SubjectExportDefinition<I> extends SubjectJobDefinition<I> {
  /** Where the parts land — a thunk, read per write, as `exportRows()` takes it. */
  readonly sink: () => ExportSink;
  /** The artifact's key prefix: `<prefix>/<table>/part-00000.<ext>`, `<prefix>/index.json`. */
  prefix(input: I): string;
  readonly format: ExportFormat;
  readonly clock?: Clock;
}

/** The subject planned against every registered entity, its first refusal thrown. */
export function plannedSubject<I>(subject: Subject<I>): SubjectPlan {
  const { plan, problems } = planSubject({
    subject: subject.entity,
    tables: subject.init.tables,
    columns: subject.init.columns,
    entries: registeredEntities(),
  });
  const [first] = problems;
  if (first !== undefined) throw first;
  return plan;
}

const readerFor = <I>(subject: Subject<I>, input: I): SubjectReader =>
  subjectReader(subject, plannedSubject(subject), subject.init.key(input));

const common = <I>(definition: SubjectJobDefinition<I>) => ({
  name: definition.name,
  input: definition.input,
  tenant: definition.tenant,
  retry: definition.retry ?? DEFAULT_RETRY,
  ...(definition.queue === undefined ? {} : { queue: definition.queue }),
  ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
});

export function subjectErase<I>(definition: SubjectJobDefinition<I>): JobHandle<I> {
  const { subject } = definition;
  return job<I>({
    ...common(definition),
    // One live erase per person: a second request while one runs is the same run.
    idempotencyKey: (input) => `${definition.name}:${subject.init.key(input)}`,
    run: ({ step, input }): Promise<SubjectEraseReport> =>
      subjectErasePass(step, readerFor(subject, input), subject.init.targets ?? []),
  });
}

export function subjectExport<I>(definition: SubjectExportDefinition<I>): JobHandle<I> {
  const { subject } = definition;
  const clock = definition.clock ?? systemClock;
  return job<I>({
    ...common(definition),
    // One live pass per artifact, derived as `exportRows()` derives it.
    idempotencyKey: (input) => `${definition.name}:${definition.prefix(input)}`,
    run: ({ step, input, runId }): Promise<SubjectExportReport> =>
      subjectExportPass(
        step,
        {
          name: definition.name,
          runId,
          prefix: definition.prefix(input),
          format: definition.format,
          sink: { put: (key, body) => definition.sink().put(key, body) },
          nowMs: () => nowMs(clock),
        },
        readerFor(subject, input),
        subject.init.targets ?? [],
      ),
  });
}

/**
 * The erase's table passes alone, for one key, under the CALLER's context and step runner — what
 * `subjectProof` (`@ultimat3/testing`) drives on generated rows. Targets are skipped: they hold no
 * entity rows the proof could search, and the job is still what an app enqueues.
 */
export function subjectEraseTables<I>(
  subject: Subject<I>,
  key: string,
  step: StepApi,
): Promise<SubjectEraseReport> {
  return subjectErasePass(step, subjectReader(subject, plannedSubject(subject), key), []);
}
