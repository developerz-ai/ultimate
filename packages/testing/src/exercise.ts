// `runExercisePass`: every registered action, query and job, run once with no test written. Each
// gets its own pair of committed tenants from the pass's one seed graph, an actor its policy allows,
// and the input 39's minimal draw gives with seeded ids bound in; the verdict is 39's loop.
//
// Committed, never rolled back. Around that call the tenant proof runs: the pair's other tenant
// calls with the first one's ids before and after it (`tenant-proof.ts`, plan 101, 40). A reached
// job is then killed at every step boundary (`exercise-crash.ts`).

import type { Actor, ExerciseAttempt, ExerciseVerdict } from '@ultimat3/core';
import { isUltimateError, renderThrowable, runExercise } from '@ultimat3/core';
import { registeredJobs } from '@ultimat3/jobs';
import type { ExerciseOverride, ExerciseOverrides } from './define-exercise';
import { assertOverridesKnown, unknownDeclaration } from './define-exercise';
import type { RoleGrants } from './exercise-actor';
import { chooseActor } from './exercise-actor';
import { proveCrash } from './exercise-crash';
import { defectDetail } from './exercise-defect';
import { ambientJobRows } from './exercise-job-run';
import type { IdLookup, Sampler } from './exercise-input';
import {
  bindIds,
  drawInput,
  idStem,
  loadSampler,
  namesActorEntity,
  seededIds,
} from './exercise-input';
import type { OverrideInput } from './exercise-override-input';
import { overrideInput } from './exercise-override-input';
import type {
  EffectPayload,
  ExerciseEffect,
  ExerciseRecord,
  ExerciseRoom,
  Observed,
} from './exercise-report';
import { openExerciseRoom, overrideLine } from './exercise-report';
import { withExerciseSetup } from './exercise-setup';
import type { Subject } from './exercise-subjects';
import { fixedTenant, seatIn, subjectsOf } from './exercise-subjects';
import { actorRowsOf, attachSweeps, seated, sizedCall } from './exercise-sweeps';
import type { RunJobs } from './fixture-jobs';
import { testJobs } from './fixture-jobs';
import { deferredMayStayNull, pairGraph, seedPass, tenantPair } from './seed-graph-pass';
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

/**
 * Jobs the primitive queued, its own job excepted. Never run: a job's children are left queued as
 * an action's are (`exercise-job-run.ts`), so their statements are theirs, never this record's.
 */
async function enqueued(subject: Subject, jobs: RunJobs) {
  const effects: ExerciseEffect[] = [];
  for (const handle of registeredJobs()) {
    if (subject.kind === 'job' && handle.name === subject.name) continue;
    const count = await jobs.depth(handle);
    if (count > 0) effects.push({ kind: 'enqueue', job: handle.name, count });
  }
  return effects;
}

/**
 * Every job a B leg's queue holds or ran, with its input — the subject's own job excepted, whose
 * input is what B was handed. Read off the leg's own queue, page by page.
 */
async function queuedPayloads(subject: Subject): Promise<readonly EffectPayload[]> {
  return (await ambientJobRows())
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
  readonly bindInput: OverrideInput | undefined;
}

/** A's positive control: 39's loop, as the pass has always run it. */
async function control(
  run: Prepared,
  room: ExerciseRoom,
  sampler: Sampler,
): Promise<{ readonly record: ExerciseRecord; readonly output: unknown; readonly input: unknown }> {
  const { subject, actor, tenant, declaredRuns, lookups, bindInput } = run;
  const { kind, name } = subject;
  let binds = 0;
  await using jobs = await testJobs();
  let answered = false;
  let lastError: unknown;
  let lastInput: unknown;
  let output: unknown;
  room.begin(name);
  const started = performance.now();
  const verdict = await runExercise({
    name,
    runs: run.runs,
    stoppedLabel: 'stopped before the call answered',
    // The minimal draw on every run the pass adds; 39's seeded draw only on runs an override asks.
    draw: (at, n) => drawInput(sampler, subject.input, at, declaredRuns === undefined ? 0 : n),
    bind: async (drawn) => {
      const bound = bindIds(drawn, lookups[binds++ === 0 ? 0 : 1]);
      const given = bindInput === undefined ? bound : await bindInput(bound, actor);
      lastInput = seatIn(subject, given, tenant);
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
  const observed = room.end();
  const effects = [...observed.effects, ...(await enqueued(subject, jobs))];
  const verdictOf = judged(subject, { verdict, answered, lastError, lastInput }, observed);
  // A 5xx's cause, statement and fields: the code alone sent the author to reproduce it by hand.
  const defect =
    verdict.kind === 'defect' && verdictOf.outcome === 'unreached'
      ? await defectDetail(verdict.error, verdict.input, subject.input)
      : undefined;
  const record = {
    kind,
    name,
    statements: observed.statements,
    effects,
    ms,
    ...verdictOf,
    ...(defect === undefined ? {} : { defect }),
  };
  return { record, output, input: lastInput };
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
  room.begin(subject.name);
  let output: unknown;
  // A job's org is re-seated in B's: B cannot enqueue a payload naming A (refused at the enqueue,
  // which proves nothing), so the attack that matters is a job of B's carrying A's ids.
  const sent = seatIn(subject, input, tenant);
  // Every `crossTenant()` B's call opened: a job's declared sweep is told from a leak by it alone.
  // Loaded here, never at the top: the barrel stays entity-free (`seed-writer.ts`'s rule).
  const { setCrossTenantObserver } = await import('@ultimat3/entity');
  const crossings: string[] = [];
  setCrossTenantObserver((reason) => crossings.push(reason));
  try {
    const answer = await subject.call(sent, actor, tenant, jobs);
    output = answer.output;
  } catch {
    // B's refusal is the answer a scoped primitive gives: only what B got back, and what B's call
    // did to A's rows, is judged — never whether B was refused.
  } finally {
    setCrossTenantObserver(undefined);
  }
  const observed = room.end();
  const payloads = [...observed.payloads, ...(await queuedPayloads(subject))];
  return { output, payloads, crossings };
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
  const bindInput = overrideInput(name, override);
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
  const given = bindInput === undefined ? drawn : await bindInput(drawn, actor);
  const seat = subject.seat?.(given, tenant);
  if (seat?.kind === 'fixed') {
    const fixed = fixedTenant(name, seat.declared);
    return {
      ...none,
      outcome: 'unreached',
      ...fixed,
      tenant: { verdict: 'unproven', reason: fixed.reason },
    };
  }
  const input = seat === undefined ? given : seat.input;
  let reachedWith: unknown;
  const record = await proveTenant({
    taint: tenantTaint(graph, tenant),
    input,
    public: publicReason(subject.policy),
    read: kind === 'query',
    sweep: kind === 'job',
    attack: () => attack(subject, input, intruder, other, room),
    control: async () => {
      const done = await control(run, room, sampler);
      reachedWith = done.input;
      return done;
    },
    snapshot: (seeded) => options.writer.snapshot(seeded),
  });
  // After the tenant proof, outside the room's begin/end: the crash runs' effects are their own.
  return subject.handle === undefined || record.outcome !== 'reached'
    ? record
    : { ...record, crash: await proveCrash(subject.handle, reachedWith, actor) };
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
  // The app's setup runs inside the seal, before the first row: its routes answer every call.
  const room = await withExerciseSetup(await openExerciseRoom(), options.overrides?.setup);
  const live = chosen.filter((subject) => !isOff(options.overrides, subject.name));
  const records: ExerciseRecord[] = [];
  let graph: SeedGraph;
  try {
    // Seeded before the first primitive runs: a failure here is the pass's, never one primitive's.
    graph = await seedPass(options.entities, options.writer, {
      primitives: live.length,
      seed: passSeed,
      ...(options.overrides?.factories === undefined
        ? {}
        : { factories: options.overrides.factories }),
    });
    // In order, one at a time: the seams the room installs are the process's, not the primitive's.
    for (const subject of chosen) {
      const index = live.indexOf(subject);
      const at = Math.max(0, index);
      const view = pairGraph(graph, at);
      records.push(await exerciseOne(subject, options, tenantPair(graph, at), view, room, sampler));
    }
  } catch (error) {
    await room[Symbol.asyncDispose]();
    throw error;
  }
  // The sweeps: every reached primitive again at two sizes, then every statement planned.
  const reached = new Set(records.filter((r) => r.outcome === 'reached').map((r) => r.name));
  return attachSweeps(records, {
    subjects: chosen.filter((subject) => reached.has(subject.name)),
    entities: options.entities,
    // The sized graphs close their cycles as the pass's did: a refused deferred key stays null.
    writer: deferredMayStayNull(options.writer),
    main: graph,
    seed: passSeed,
    room,
    factories: options.overrides?.factories,
    setup: async (subject, sized, tenant, self) => {
      const full = chosen.find((one) => one.name === subject.name);
      return full === undefined
        ? undefined
        : await sizedCall(full, options, sampler, { graph: sized, tenant, self });
    },
  });
}
