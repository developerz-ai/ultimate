// `runExercisePass`: every registered action, query and job, run once with no test written. Each
// gets its own pair of committed tenants from the pass's one seed graph, an actor its policy allows,
// and the input 39's minimal draw gives with seeded ids bound in; the verdict is 39's loop.
//
// Committed, never rolled back. Around that call the tenant proof runs: the pair's other tenant
// calls with the first one's ids before and after it (`tenant-proof.ts`, plan 101, 40). A reached
// job is then killed at every step boundary (`exercise-crash.ts`).
//
// Each record is its primitive's alone: an entry's input that throws is that primitive unreached,
// what the input sent is never the call's, and a name two kinds share has an entry per kind.

import type { Actor, ExerciseAttempt, ExerciseVerdict } from '@ultimat3/core';
import { runExercise, subscribe } from '@ultimat3/core';
import { LIVE_STATES, registeredJobs } from '@ultimat3/jobs';
import type { ExerciseOverride, ExerciseOverrides } from './define-exercise';
import { assertOverridesKnown, overrideFor, unknownDeclaration } from './define-exercise';
import type { RoleGrants } from './exercise-actor';
import { chooseActor } from './exercise-actor';
import { seatActorUsers } from './exercise-actor-user';
import { proveCrash } from './exercise-crash';
import { defectDetail } from './exercise-defect';
import type { IdLookup, Sampler } from './exercise-input';
import { bindIds, drawInput, loadSampler, namesActorEntity, seededIds } from './exercise-input';
import { ambientJobRows } from './exercise-job-run';
import { judged, labelFor } from './exercise-judge';
import { mergeObserved } from './exercise-observed';
import type { OverrideInput } from './exercise-override-input';
import { inputThrew, overrideInput } from './exercise-override-input';
import { actorHintOf, type OverrideHint, seededIn } from './exercise-override-line';
import type {
  EffectPayload,
  ExerciseEffect,
  ExercisePhaseMs,
  ExerciseRecord,
  ExerciseRoom,
  Observed,
} from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { withExerciseSetup } from './exercise-setup';
import type { Subject } from './exercise-subjects';
import { fixedTenant, seatIn, subjectsOf } from './exercise-subjects';
import { actorRowsOf, attachSweeps, seated, sizedCall } from './exercise-sweeps';
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
  /** Told once, as the pass returns: how long each phase took, so a slow pass names its slow part. */
  readonly onPhases?: (ms: ExercisePhaseMs) => void;
}

const isOff = (overrides: ExerciseOverrides | undefined, subject: Subject): boolean => {
  const override = overrideFor(overrides, subject.kind, subject.name);
  return override !== undefined && 'off' in override;
};

/** The ids of every row the call's queue holds now: what an attempt adds is the call's. */
const queuedIds = async (): Promise<ReadonlySet<string>> =>
  new Set((await ambientJobRows()).map((record) => record.id));

/**
 * Jobs the primitive queued — rows an ATTEMPT added (`mine`), still live — its own job excepted.
 * Never run: a job's children are left queued as an action's are (`exercise-job-run.ts`). A row
 * the override's input added between calls is on the same queue, so the call can find it, and is
 * not in `mine`: the input's enqueue is never the primitive's.
 */
async function enqueued(subject: Subject, mine: ReadonlySet<string>) {
  const counts = new Map<string, number>();
  for (const record of await ambientJobRows()) {
    if (!mine.has(record.id) || !LIVE_STATES.has(record.state)) continue;
    if (subject.kind === 'job' && record.name === subject.name) continue;
    counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  }
  const order = registeredJobs().map((handle) => handle.name);
  return [...counts]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([job, count]): ExerciseEffect => ({ kind: 'enqueue', job, count }));
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

/** Everything one primitive's calls share: who acts in each tenant, and how ids are bound. */
interface Prepared {
  readonly subject: Subject;
  /** The entry key and room label: `labelFor`'s. */
  readonly key: string;
  readonly options: ExercisePassOptions;
  readonly tenant: string;
  readonly actor: Actor | null;
  readonly runs: number;
  readonly declaredRuns: number | undefined;
  readonly lookups: readonly [IdLookup, IdLookup];
  readonly bindInput: OverrideInput | undefined;
  /** The actor the pass picked, as the paste line spells it (`exercise-override-line.ts`). */
  readonly actorHint: OverrideHint['actor'];
}

/** Thrown out of 39's loop by a bind that failed: the record is the entry's, never the loop's. */
class BindThrew {
  constructor(readonly error: unknown) {}
}

/**
 * A's positive control: 39's loop, as the pass has always run it. The room records each CALL
 * alone: an override's input runs between calls, and what it sends is never this primitive's.
 */
async function control(
  run: Prepared,
  room: ExerciseRoom,
  sampler: Sampler,
): Promise<{ readonly record: ExerciseRecord; readonly output: unknown; readonly input: unknown }> {
  const { subject, key, actor, tenant, declaredRuns, lookups, bindInput } = run;
  const { kind, name } = subject;
  let binds = 0;
  await using jobs = await testJobs();
  let answered = false;
  let lastError: unknown;
  let lastInput: unknown;
  let output: unknown;
  const segments: Observed[] = [];
  const mine = new Set<string>();
  const started = performance.now();
  let verdict: ExerciseVerdict;
  try {
    verdict = await runExercise({
      name,
      runs: run.runs,
      stoppedLabel: 'stopped before the call answered',
      // The minimal draw on every run the pass adds; 39's seeded draw only on runs an override asks.
      draw: (at, n) => drawInput(sampler, subject.input, at, declaredRuns === undefined ? 0 : n),
      bind: async (drawn) => {
        const bound = bindIds(drawn, lookups[binds++ === 0 ? 0 : 1]);
        try {
          // On the call's own queue: a job the input enqueues is there when the call looks it up.
          const given =
            bindInput === undefined ? bound : await bindInput(bound, actor, { onCallQueue: true });
          lastInput = seatIn(subject, given, tenant);
        } catch (error) {
          throw new BindThrew(error);
        }
        return lastInput;
      },
      accepts: async (input) =>
        (await subject.input['~standard'].validate(input)).issues === undefined,
      attempt: async (input): Promise<ExerciseAttempt> => {
        const before = await queuedIds();
        const seen = await room.observe(key, () => subject.call(input, actor, tenant, jobs));
        segments.push(seen.observed);
        for (const id of await queuedIds()) if (!before.has(id)) mine.add(id);
        if ('error' in seen) {
          lastError = seen.error;
          return { ok: false, reached: false, error: seen.error };
        }
        const answer = seen.value;
        if ('failure' in answer) {
          lastError = answer.failure;
          return { ok: false, reached: true, error: answer.failure };
        }
        answered = true;
        output = answer.output;
        return { ok: true, reached: true };
      },
      statusOf: (await import('@ultimat3/http')).statusFor,
    });
  } catch (error) {
    if (!(error instanceof BindThrew)) throw error;
    const observed = mergeObserved(segments);
    const record = {
      kind,
      name,
      statements: observed.statements,
      effects: observed.effects,
      ms: Math.round(performance.now() - started),
      ...inputThrew(name, key, error.error),
    };
    return { record, output, input: lastInput };
  }
  const ms = Math.round(performance.now() - started);
  const observed = mergeObserved(segments);
  const effects = [...observed.effects, ...(await enqueued(subject, mine))];
  const hint = { actor: run.actorHint, ids: seededIn(lastInput, lookups) };
  const outcome = { verdict, answered, lastError, lastInput, hint };
  const verdictOf = judged(subject, key, outcome, observed, sampler);
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
  key: string,
  input: unknown,
  actor: Actor | null,
  tenant: string,
  room: ExerciseRoom,
): Promise<LegAnswer> {
  await using jobs = await testJobs();
  let output: unknown;
  // A job's org is re-seated in B's: B cannot enqueue a payload naming A (refused at the enqueue,
  // which proves nothing), so the attack that matters is a job of B's carrying A's ids.
  const sent = seatIn(subject, input, tenant);
  // Every `crossTenant()` B's call opened: a job's declared sweep is told from a leak by it alone.
  // On the bus, so the barrel stays entity-free (`seed-writer.ts`'s rule) with no import at all.
  const crossings: string[] = [];
  // B's own: a scope another context opened in the window excuses nothing of B's.
  const offCrossings = subscribe('entity.cross_tenant', (event) => {
    if (room.owns()) crossings.push(event.payload.reason);
  });
  let observed: Observed;
  try {
    // A throw is B's refusal, the answer a scoped primitive gives: only what B got back, and what
    // B's call did to A's rows, is judged — never whether B was refused.
    const seen = await room.observe(key, () => subject.call(sent, actor, tenant, jobs));
    observed = seen.observed;
    if ('value' in seen) output = seen.value.output;
  } finally {
    offCrossings();
  }
  const payloads = [...observed.payloads, ...(await queuedPayloads(subject))];
  return { output, payloads, crossings };
}

async function exerciseOne(
  subject: Subject,
  key: string,
  options: ExercisePassOptions,
  [tenant, other]: readonly [string, string],
  graph: SeedGraph,
  room: ExerciseRoom,
  sampler: Sampler,
): Promise<ExerciseRecord> {
  const { kind, name } = subject;
  const override: ExerciseOverride | undefined = overrideFor(options.overrides, kind, name);
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
  // Both are users, as a request's actor always is: their `x_users` rows, before any call.
  await seatActorUsers([actor, intruder]);

  const scope = { tenant, actorId: actor?.id, subject: name, actorEntity: rows?.entity.$name };
  const bindInput = overrideInput(name, override);
  // `off` returned above: any other entry's `runs` is declared, with or without an `actor`.
  const declaredRuns = override === undefined || 'off' in override ? undefined : override.runs;
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
    key,
    options,
    tenant,
    actor,
    runs: declaredRuns ?? (twoWay ? 2 : 1),
    declaredRuns,
    lookups,
    bindInput,
    actorHint: actorHintOf(chosen, override),
  };
  // A's own first input, A's ids in it: B sends exactly what A legitimately would.
  const drawn = bindIds(drawInput(sampler, subject.input, 0, 0), lookups[0]);
  let given: unknown;
  try {
    given = bindInput === undefined ? drawn : await bindInput(drawn, actor);
  } catch (error) {
    const threw = inputThrew(name, key, error);
    return { ...none, ...threw, tenant: { verdict: 'unproven', reason: threw.reason } };
  }
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
  const tenantStarted = performance.now();
  const record = await proveTenant({
    taint: tenantTaint(graph, tenant),
    input,
    public: publicReason(subject.policy),
    read: kind === 'query',
    sweep: kind === 'job',
    tenantless: seat?.kind === 'none',
    attack: () => attack(subject, key, input, intruder, other, room),
    control: async () => {
      const done = await control(run, room, sampler);
      reachedWith = done.input;
      return done;
    },
    snapshot: (seeded) => options.writer.snapshot(seeded),
  });
  // The control's own call is `ms`: the tenant proof's time is everything around it.
  const tenantMs = Math.max(0, Math.round(performance.now() - tenantStarted) - record.ms);
  // After the tenant proof, outside the room's begin/end: the crash runs' effects are their own.
  if (subject.handle === undefined || record.outcome !== 'reached') {
    return { ...record, proofMs: { tenant: tenantMs } };
  }
  const crashStarted = performance.now();
  const crash = await proveCrash(subject.handle, reachedWith, actor);
  const proofMs = { tenant: tenantMs, crash: Math.round(performance.now() - crashStarted) };
  return { ...record, crash, proofMs };
}

export async function runExercisePass(
  options: ExercisePassOptions,
): Promise<readonly ExerciseRecord[]> {
  // Each call's request is its entry's, read by kind: an action's cookies are never its job twin's.
  const subjects = await subjectsOf((kind, name) => {
    const entry = overrideFor(options.overrides, kind, name);
    return entry === undefined || 'off' in entry ? undefined : entry.request;
  });
  const known = new Set(subjects.map((subject) => subject.name));
  assertOverridesKnown(options.overrides, subjects);
  const label = labelFor(subjects);
  if (options.only !== undefined && !known.has(options.only)) {
    throw unknownDeclaration([options.only], known, 'x exercise');
  }
  const chosen = subjects.filter((s) => options.only === undefined || s.name === options.only);
  const sampler = await loadSampler();
  // Not `Math.random`: the frozen RNG answers the same sequence in every process.
  const passSeed = options.seed ?? (crypto.getRandomValues(new Uint32Array(1))[0] as number);
  // The app's setup runs inside the seal, before the first row: its routes answer every call.
  const room = await withExerciseSetup(await openExerciseRoom(), options.overrides?.setup);
  const live = chosen.filter((subject) => !isOff(options.overrides, subject));
  const records: ExerciseRecord[] = [];
  let graph: SeedGraph;
  const seedStarted = performance.now();
  let primitivesStarted = seedStarted;
  try {
    // Seeded before the first primitive runs: a failure here is the pass's, never one primitive's.
    graph = await seedPass(options.entities, options.writer, {
      primitives: live.length,
      seed: passSeed,
      ...(options.overrides?.factories === undefined
        ? {}
        : { factories: options.overrides.factories }),
    });
    primitivesStarted = performance.now();
    // In order, one at a time: the seams the room installs are the process's, not the primitive's.
    for (const subject of chosen) {
      const index = live.indexOf(subject);
      const at = Math.max(0, index);
      const view = pairGraph(graph, at);
      const pair = tenantPair(graph, at);
      records.push(await exerciseOne(subject, label(subject), options, pair, view, room, sampler));
    }
  } catch (error) {
    await room[Symbol.asyncDispose]();
    throw error;
  }
  const seed = Math.round(primitivesStarted - seedStarted);
  const primitives = Math.round(performance.now() - primitivesStarted);
  // The sweeps: every reached primitive again at two sizes, then every statement planned.
  const reached = new Set(records.filter((r) => r.outcome === 'reached').map(label));
  const swept = await attachSweeps(records, label, {
    // Named by label: the sweeps key their proofs by name, and a shared name is two primitives.
    subjects: chosen
      .filter((subject) => reached.has(label(subject)))
      .map((subject) => ({ ...subject, name: label(subject) })),
    entities: options.entities,
    // The sized graphs close their cycles as the pass's did: a refused deferred key stays null.
    writer: deferredMayStayNull(options.writer),
    main: graph,
    seed: passSeed,
    room,
    factories: options.overrides?.factories,
    setup: async (subject, sized, tenant, self) => {
      const full = chosen.find((one) => label(one) === subject.name);
      if (full === undefined) return undefined;
      const call = await sizedCall(full, options, sampler, { graph: sized, tenant, self });
      // Before the sweep's room opens: the sized tenant's actor is a user too.
      if (call !== undefined) await seatActorUsers([call.actor]);
      return call;
    },
  });
  options.onPhases?.({ seed, primitives, ...swept.ms });
  return swept.records;
}
