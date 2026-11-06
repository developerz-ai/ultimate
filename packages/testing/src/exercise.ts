// `runExercisePass`: every registered action, query and job, run once with no test written. Each
// gets its own pair of committed tenants from the pass's one seed graph, an actor its policy allows,
// and the input 39's minimal draw gives with seeded ids bound in; the verdict is 39's loop.
//
// Committed, never rolled back. Around that call the tenant proof runs: the pair's other tenant
// calls with the first one's ids before and after it (`tenant-proof.ts`, plan 101, 40).

import type { Actor, ExerciseAttempt, ExerciseVerdict } from '@ultimat3/core';
import { bindDrawn, isUltimateError, renderThrowable, runExercise } from '@ultimat3/core';
import type { AnyJobHandle, JobExecution, JobRecord } from '@ultimat3/jobs';
import { registeredJobs } from '@ultimat3/jobs';
import type { Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ExerciseOverride, ExerciseOverrides } from './define-exercise';
import { assertOverridesKnown, unknownDeclaration } from './define-exercise';
import type { ActorRows, RoleGrants } from './exercise-actor';
import { asSeededRow, chooseActor } from './exercise-actor';
import type { IdLookup, Sampler } from './exercise-input';
import {
  bindIds,
  drawInput,
  idStem,
  loadSampler,
  namesActorEntity,
  seededIds,
} from './exercise-input';
import type {
  EffectPayload,
  ExerciseEffect,
  ExerciseRecord,
  ExerciseRoom,
  Observed,
} from './exercise-report';
import { openExerciseRoom, overrideLine } from './exercise-report';
import { withExerciseRequest } from './exercise-request';
import type { RunJobs } from './fixture-jobs';
import { testJobs } from './fixture-jobs';
import { seedPass, tenantPair } from './seed-graph-pass';
import type { SeedGraph, SeedWriter } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { tenantTaint } from './tenant-canary';
import type { LegAnswer } from './tenant-proof';
import { proveTenant, publicReason, withoutCrossTenant } from './tenant-proof';

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
  /** Resolves to the failure a worker recorded on the row (a job's), or what the call answered. */
  call(input: unknown, actor: Actor | null, tenant: string, jobs: RunJobs): Promise<Answer>;
}

/** `failure` set: the worker recorded one (a job's). Absent: answered, with `output`. */
interface Answer {
  readonly failure?: unknown;
  readonly output?: unknown;
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
      return own !== undefined && ANSWERED.has(own.outcome)
        ? { output: own.result }
        : { failure: statusOfJobFailure(own) };
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
        call: async (input, actor) => ({
          output: await withExerciseRequest(target.name, actor, () =>
            invoke(target, input, { surface: 'http' }),
          ),
        }),
      }),
    ),
    ...listQueries().map(
      (target): Subject => ({
        kind: 'query',
        name: target.name,
        input: target.input,
        policy: target.policy,
        permissions: target.describe().permissions,
        call: async (input, actor) => ({
          output: await withExerciseRequest(target.name, actor, () =>
            runQuery(target, input, { surface: 'http' }),
          ),
        }),
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

/**
 * Every job a B leg's queue holds or ran, with its input — the subject's own job excepted, whose
 * input is what B was handed. Read off the leg's own queue, page by page.
 */
async function queuedPayloads(subject: Subject): Promise<readonly EffectPayload[]> {
  const jobs = await import('@ultimat3/jobs');
  const introspect = jobs.jobDriver()?.introspect;
  if (introspect === undefined) return [];
  const records: JobRecord[] = [];
  for (let after: string | undefined; ; ) {
    const page = await introspect.list({
      limit: jobs.MAX_JOB_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    records.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < jobs.MAX_JOB_PAGE) break;
    after = jobs.jobCursor(last);
  }
  return records
    .filter((record) => !(subject.kind === 'job' && record.name === subject.name))
    .map((record, i) => ({
      path: `effect.enqueue[${i}]`,
      value: { job: record.name, input: record.input },
    }));
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

/** Everything one primitive's calls share: who acts in each tenant, and how ids are bound. */
interface Prepared {
  readonly subject: Subject;
  readonly options: ExercisePassOptions;
  readonly tenant: string;
  readonly actor: Actor | null;
  readonly runs: number;
  readonly declaredRuns: number | undefined;
  readonly lookups: readonly [IdLookup, IdLookup];
  readonly bindInput: ((drawn: unknown) => unknown) | undefined;
}

/** The actor of `chosen`, seated as a row of the app's actor entity in `tenant` when it names one. */
const seated = (actor: Actor | null, tenant: string, rows: ActorRows | undefined) =>
  rows === undefined ? actor : asSeededRow(actor, tenant, rows);

/** A's positive control: 39's loop, as the pass has always run it. */
async function control(
  run: Prepared,
  room: ExerciseRoom,
  sampler: Sampler,
): Promise<{ readonly record: ExerciseRecord; readonly output: unknown }> {
  const { subject, actor, tenant, declaredRuns, lookups, bindInput } = run;
  const { kind, name } = subject;
  let binds = 0;
  await using jobs = await testJobs();
  let answered = false;
  let lastError: unknown;
  let lastInput: unknown;
  let output: unknown;
  let executions: readonly JobExecution[] = [];
  room.begin();
  const started = performance.now();
  const verdict = await runExercise({
    name,
    runs: run.runs,
    stoppedLabel: 'stopped before the call answered',
    // The minimal draw on every run the pass adds; 39's seeded draw only on runs an override asks.
    draw: (at, n) => drawInput(sampler, subject.input, at, declaredRuns === undefined ? 0 : n),
    bind: (drawn) => {
      const bound = bindIds(drawn, lookups[binds++ === 0 ? 0 : 1]);
      lastInput = bindInput === undefined ? bound : bindInput(bound);
      return lastInput;
    },
    accepts: async (input) =>
      (await subject.input['~standard'].validate(input)).issues === undefined,
    attempt: async (input): Promise<ExerciseAttempt> => {
      try {
        const answer = await subject.call(input, actor, tenant, jobs);
        if ('failure' in answer) {
          lastError = answer.failure;
          return { ok: false, reached: true, error: answer.failure };
        }
        answered = true;
        output = answer.output;
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
  const record = { kind, name, statements: observed.statements, effects, ms, ...verdictOf };
  return { record, output };
}

/** One B leg: B's actor, A's ids, a queue of its own. What it answered and every effect it had. */
async function attack(
  subject: Subject,
  input: unknown,
  actor: Actor | null,
  tenant: string,
  room: ExerciseRoom,
): Promise<LegAnswer> {
  await using jobs = await testJobs();
  room.begin();
  let output: unknown;
  try {
    const answer = await subject.call(input, actor, tenant, jobs);
    output = answer.output;
  } catch {
    // B's refusal is the answer a scoped primitive gives: only what B got back, and what B's call
    // did to A's rows, is judged — never whether B was refused.
  }
  const observed = room.end();
  return { output, payloads: [...observed.payloads, ...(await queuedPayloads(subject))] };
}

async function exerciseOne(
  subject: Subject,
  options: ExercisePassOptions,
  [tenant, other]: readonly [string, string],
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
  const actor = seated(chosen.actor, tenant, rows);
  // B is chosen as A was, in B's own tenant: the same role, so the policy is not what stops it.
  const theirs = chooseActor(subject.policy, subject.permissions, options.roles, other, override);
  const intruder = withoutCrossTenant(
    theirs.kind === 'actor' ? seated(theirs.actor, other, rows) : null,
  );

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
  const run: Prepared = {
    subject,
    options,
    tenant,
    actor,
    runs: declaredRuns ?? (twoWay ? 2 : 1),
    declaredRuns,
    lookups,
    bindInput,
  };
  // A's own first input, A's ids in it: B sends exactly what A legitimately would.
  const drawn = bindIds(drawInput(sampler, subject.input, 0, 0), lookups[0]);
  const input = bindInput === undefined ? drawn : bindInput(drawn);
  return proveTenant({
    taint: tenantTaint(graph, tenant),
    input,
    public: publicReason(subject.policy),
    read: kind === 'query',
    attack: () => attack(subject, input, intruder, other, room),
    control: () => control(run, room, sampler),
    snapshot: (seeded) => options.writer.snapshot(seeded),
  });
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
    const pair = tenantPair(graph, Math.max(0, index));
    records.push(await exerciseOne(subject, options, pair, graph, room, sampler));
  }
  return records;
}
