// `runExercisePass`: every registered action, query and job, run once with no test written. Each
// gets its own pair of committed tenants from the pass's one seed graph, an actor its policy allows,
// and the input 39's minimal draw gives with seeded ids bound in; the verdict is 39's loop.
// Committed, never rolled back: a later proof reads the rows after the call (plan 101, 40).

import type { Actor, ExerciseAttempt, ExerciseVerdict } from '@ultimat3/core';
import { bindDrawn, isUltimateError, renderThrowable, runExercise } from '@ultimat3/core';
import type { AnyJobHandle, JobExecution } from '@ultimat3/jobs';
import { registeredJobs } from '@ultimat3/jobs';
import type { Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ExerciseOverride, ExerciseOverrides } from './define-exercise';
import { assertOverridesKnown, unknownDeclaration } from './define-exercise';
import type { ActorRows, RoleGrants } from './exercise-actor';
import { asSeededRow, chooseActor } from './exercise-actor';
import type { Sampler } from './exercise-input';
import {
  bindIds,
  drawInput,
  idStem,
  loadSampler,
  namesActorEntity,
  seededIds,
} from './exercise-input';
import type { ExerciseEffect, ExerciseRecord, ExerciseRoom, Observed } from './exercise-report';
import { openExerciseRoom, overrideLine } from './exercise-report';
import { withExerciseRequest } from './exercise-request';
import type { RunJobs } from './fixture-jobs';
import { testJobs } from './fixture-jobs';
import { seedPass, tenantPair } from './seed-graph-pass';
import type { SeedGraph, SeedWriter } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

export interface ExercisePassOptions {
  readonly entities: readonly SeedEntity[];
  readonly writer: SeedWriter;
  /**
   * Seeds the pass's one graph: the shared rows and every primitive's tenants. Omitted, each pass
   * draws a fresh one: the rows are COMMITTED, so a second pass on one seed against one database
   * collides on its keys. Given, the pass replays byte for byte — on a database that has not seen it.
   */
  readonly seed?: number;
  readonly overrides?: ExerciseOverrides;
  /** One primitive by name; unknown is `X_DECLARATION_UNKNOWN`. */
  readonly only?: string;
  readonly roles: RoleGrants;
}

/** One primitive, as the pass drives it: the schema to draw from and the one call to make. */
interface Subject {
  readonly kind: ExerciseRecord['kind'];
  readonly name: string;
  readonly input: StandardSchemaV1;
  readonly policy: Policy | undefined;
  /** Every permission the policy references — what `x policy explain` matches grants against. */
  readonly permissions: readonly string[];
  /** Resolves to the failure a worker recorded on the row (a job's), or `undefined`: answered. */
  call(input: unknown, actor: Actor | null, tenant: string, jobs: RunJobs): Promise<unknown>;
}

const ANSWERED: ReadonlySet<string> = new Set(['completed', 'suspended']);

const statusOfJobFailure = (run: JobExecution | undefined): string =>
  run === undefined ? 'the job never ran' : (run.error ?? `the run ended ${run.outcome}`);

async function subjectsOf(): Promise<readonly Subject[]> {
  // On demand, as every fixture here loads them: the barrel stays off `action` and `query`.
  const { invoke, listActions } = await import('@ultimat3/action');
  const { listQueries, runQuery } = await import('@ultimat3/query');
  const job = (handle: AnyJobHandle): Subject => ({
    kind: 'job',
    name: handle.name,
    input: handle.input,
    policy: undefined,
    permissions: [],
    call: async (input, actor, tenant, jobs) => {
      const queued = await jobs.enqueue(handle, input, { tenantId: tenant });
      const trace = await jobs.drain(actor === null ? {} : { actor });
      const own = trace.executions.find((run) => run.jobId === queued.id);
      // The worker's failure is a string on the row, never a throw: it is the attempt's error.
      // Suspended is a body that ran and parked (`step.sleep`, `waitForEvent`): reached.
      return own !== undefined && ANSWERED.has(own.outcome) ? undefined : statusOfJobFailure(own);
    },
  });
  return [
    ...listActions().map(
      (target): Subject => ({
        kind: 'action',
        name: target.name,
        input: target.input,
        policy: target.policy,
        permissions: target.describe().permissions,
        call: async (input, actor) => {
          await withExerciseRequest(target.name, actor, () =>
            invoke(target, input, { surface: 'http' }),
          );
          return undefined;
        },
      }),
    ),
    ...listQueries().map(
      (target): Subject => ({
        kind: 'query',
        name: target.name,
        input: target.input,
        policy: target.policy,
        permissions: target.describe().permissions,
        call: async (input, actor) => {
          await withExerciseRequest(target.name, actor, () =>
            runQuery(target, input, { surface: 'http' }),
          );
          return undefined;
        },
      }),
    ),
    ...registeredJobs().map(job),
  ];
}

/** The seeded rows of the entity `defineExercise(…, { actor })` named, or none. */
const actorRowsOf = (options: ExercisePassOptions, graph: SeedGraph): ActorRows | undefined => {
  const name = options.overrides?.actorEntity;
  const entity = options.entities.find((one) => one.$name === name);
  if (entity === undefined) return undefined;
  return { entity, rows: graph.inserts.filter((row) => row.entity === entity.$name) };
};

const isOff = (overrides: ExerciseOverrides | undefined, name: string): boolean => {
  const override = overrides?.entries.get(name);
  return override !== undefined && 'off' in override;
};

const codeOf = (error: unknown): string | undefined => {
  if (isUltimateError(error)) return error.code;
  return typeof error === 'string' ? /^(X_[A-Z0-9_]+)/.exec(error)?.[1] : undefined;
};

const reasonOf = (error: unknown): string =>
  isUltimateError(error) ? error.cause : typeof error === 'string' ? error : renderThrowable(error);

/** Jobs queued or run by the primitive, the primitive's own job excepted. */
async function enqueued(subject: Subject, jobs: RunJobs, runs: readonly JobExecution[]) {
  const effects: ExerciseEffect[] = [];
  for (const handle of registeredJobs()) {
    if (subject.kind === 'job' && handle.name === subject.name) continue;
    const ran = new Set(runs.filter((run) => run.job === handle.name).map((r) => r.jobId)).size;
    const count = ran + (await jobs.depth(handle));
    if (count > 0) effects.push({ kind: 'enqueue', job: handle.name, count });
  }
  return effects;
}

interface Run {
  readonly verdict: ExerciseVerdict;
  readonly answered: boolean;
  readonly lastError: unknown;
  readonly lastInput: unknown;
}

function judged(subject: Subject, run: Run, observed: Observed) {
  const idFields = (input: unknown): readonly string[] =>
    typeof input === 'object' && input !== null
      ? Object.keys(input).filter((key) => idStem(key) !== undefined)
      : [];
  const unreached = (code: string | undefined, reason: string) => ({
    outcome: 'unreached' as const,
    ...(code === undefined ? {} : { code }),
    reason,
    override: overrideLine(subject.name, idFields(run.lastInput)),
  });
  if (observed.refusedHosts.length > 0) {
    // A call out is a refusal whatever the handler made of it: sealed, so never sent.
    const hosts = [...new Set(observed.refusedHosts)].join(', ');
    return unreached('X_TEST_NETWORK_SEALED', `called out to ${hosts}: sealed, never sent`);
  }
  if (run.verdict.kind === 'pass' && run.answered) return { outcome: 'reached' as const };
  if (run.verdict.kind === 'drift') {
    return unreached('X_CONTRACT_DRIFT', 'its input schema refused every generated value');
  }
  if (run.verdict.kind === 'defect') {
    return unreached(codeOf(run.verdict.error) ?? 'X_CONTRACT_DEFECT', run.verdict.defect);
  }
  return unreached(codeOf(run.lastError), reasonOf(run.lastError));
}

async function exerciseOne(
  subject: Subject,
  options: ExercisePassOptions,
  tenant: string,
  graph: SeedGraph,
  room: ExerciseRoom,
  sampler: Sampler,
): Promise<ExerciseRecord> {
  const { kind, name } = subject;
  const override: ExerciseOverride | undefined = options.overrides?.entries.get(name);
  const none = { kind, name, statements: 0, effects: [], ms: 0 };
  if (override !== undefined && 'off' in override) {
    return { ...none, outcome: 'off', reason: override.off.trim() };
  }
  const chosen = chooseActor(subject.policy, subject.permissions, options.roles, tenant, override);
  if (chosen.kind === 'refused') return { ...none, outcome: 'refused', reason: chosen.reason };
  const rows = actorRowsOf(options, graph);
  const actor = rows === undefined ? chosen.actor : asSeededRow(chosen.actor, tenant, rows);

  const scope = { tenant, actorId: actor?.id, subject: name, actorEntity: rows?.entity.$name };
  const bindInput = bindDrawn(
    override !== undefined && 'actor' in override ? override.input : undefined,
  );
  const declaredRuns = override !== undefined && 'actor' in override ? override.runs : undefined;
  // A field naming the actor entity is tried as the actor's own row, then as somebody else's:
  // both readings are legitimate and only the handler knows which it meant. Same minimal draw.
  const twoWay =
    declaredRuns === undefined &&
    actor !== null &&
    namesActorEntity(sampler.sampleInput(subject.input), options.entities, scope);
  const lookups = [
    seededIds(graph, options.entities, { ...scope, self: true }),
    seededIds(graph, options.entities, { ...scope, self: false }),
  ] as const;
  let binds = 0;

  await using jobs = await testJobs();
  let answered = false;
  let lastError: unknown;
  let lastInput: unknown;
  let executions: readonly JobExecution[] = [];
  room.begin();
  const started = performance.now();
  const verdict = await runExercise({
    name,
    runs: declaredRuns ?? (twoWay ? 2 : 1),
    stoppedLabel: 'stopped before the call answered',
    // The minimal draw on every run the pass adds; 39's seeded draw only on runs an override asks.
    draw: (at, run) => drawInput(sampler, subject.input, at, declaredRuns === undefined ? 0 : run),
    bind: (drawn) => {
      const bound = bindIds(drawn, lookups[binds++ === 0 ? 0 : 1]);
      lastInput = bindInput === undefined ? bound : bindInput(bound);
      return lastInput;
    },
    accepts: async (input) =>
      (await subject.input['~standard'].validate(input)).issues === undefined,
    attempt: async (input): Promise<ExerciseAttempt> => {
      try {
        const failure = await subject.call(input, actor, tenant, jobs);
        if (failure !== undefined) {
          lastError = failure;
          return { ok: false, reached: true, error: failure };
        }
        answered = true;
        return { ok: true, reached: true };
      } catch (error) {
        lastError = error;
        return { ok: false, reached: false, error };
      }
    },
    statusOf: (await import('@ultimat3/http')).statusFor,
  });
  const ms = Math.round(performance.now() - started);
  if (kind === 'job') executions = (await jobs.drain()).executions;
  const observed = room.end();
  const effects = [...observed.effects, ...(await enqueued(subject, jobs, executions))];
  const verdictOf = judged(subject, { verdict, answered, lastError, lastInput }, observed);
  return { kind, name, statements: observed.statements, effects, ms, ...verdictOf };
}

export async function runExercisePass(
  options: ExercisePassOptions,
): Promise<readonly ExerciseRecord[]> {
  const subjects = await subjectsOf();
  const known = new Set(subjects.map((subject) => subject.name));
  assertOverridesKnown(options.overrides, known);
  if (options.only !== undefined && !known.has(options.only)) {
    throw unknownDeclaration([options.only], known, 'x exercise');
  }
  const chosen = subjects.filter((s) => options.only === undefined || s.name === options.only);
  const sampler = await loadSampler();
  // Not `Math.random`: the frozen RNG answers the same sequence in every process.
  const passSeed = options.seed ?? (crypto.getRandomValues(new Uint32Array(1))[0] as number);
  await using room = await openExerciseRoom();
  const live = chosen.filter((subject) => !isOff(options.overrides, subject.name));
  // Seeded before the first primitive runs: a failure here is the pass's, never one primitive's.
  const graph = await seedPass(options.entities, options.writer, {
    primitives: live.length,
    seed: passSeed,
  });
  const records: ExerciseRecord[] = [];
  // In order, one at a time: the seams the room installs are the process's, not the primitive's.
  for (const subject of chosen) {
    const index = live.indexOf(subject);
    const [tenant] = tenantPair(graph, Math.max(0, index));
    records.push(await exerciseOne(subject, options, tenant, graph, room, sampler));
  }
  return records;
}
