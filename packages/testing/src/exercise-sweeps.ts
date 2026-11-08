// What runs after every primitive's own call: the scale sweep (each reached one again, at 2 and at 8
// rows a table) and the plan sweep (every statement the pass sent, planned on the migrated
// database). Both verdicts land on the record of the primitive that sent the statements, and each
// sweep's time on the pass.

import type { Actor } from '@ultimat3/core';
import type { ExerciseOverrides } from './define-exercise';
import type { ActorRows, RoleGrants } from './exercise-actor';
import { asSeededRow, chooseActor } from './exercise-actor';
import type { Sampler } from './exercise-input';
import { bindIds, drawInput, seededIds } from './exercise-input';
import { overrideInput } from './exercise-override-input';
import type { ExercisePhaseMs, ExerciseRecord } from './exercise-report';
import type { Subject } from './exercise-subjects';
import { seatIn } from './exercise-subjects';
import { sweepPlans } from './plan-sweep';
import type { ScaleSubject, ScaleSweepOptions } from './scale-sweep-run';
import { scaleSweep } from './scale-sweep-run';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** The pass's options, as far as choosing who calls and with what goes. */
interface CallOptions {
  readonly entities: readonly SeedEntity[];
  readonly overrides?: ExerciseOverrides;
  readonly roles: RoleGrants;
}

/** The seeded rows of the entity `defineExercise(…, { actor })` named, or none. */
export const actorRowsOf = (options: CallOptions, graph: SeedGraph): ActorRows | undefined => {
  const name = options.overrides?.actorEntity;
  const entity = options.entities.find((one) => one.$name === name);
  if (entity === undefined) return undefined;
  return { entity, rows: graph.inserts.filter((row) => row.entity === entity.$name) };
};

/** The actor of `chosen`, seated as a row of the app's actor entity in `tenant` when it names one. */
export const seated = (actor: Actor | null, tenant: string, rows: ActorRows | undefined) =>
  rows === undefined ? actor : asSeededRow(actor, tenant, rows);

/** A primitive as a sized call needs it: its schema, its policy, and a job's seat. */
type Callable = Pick<Subject, 'name' | 'input' | 'policy' | 'permissions' | 'seat'>;

/** One call of `subject` in `tenant` of a sized graph: the control's actor and first input. */
export async function sizedCall(
  subject: Callable,
  options: CallOptions,
  sampler: Sampler,
  at: { readonly graph: SeedGraph; readonly tenant: string; readonly self: boolean },
): Promise<{ readonly actor: Actor | null; readonly input: unknown } | undefined> {
  const { graph, tenant, self } = at;
  const override = options.overrides?.entries.get(subject.name);
  const chosen = chooseActor(subject.policy, subject.permissions, options.roles, tenant, override);
  if (chosen.kind === 'refused') return undefined;
  const rows = actorRowsOf(options, graph);
  const actor = seated(chosen.actor, tenant, rows);
  const scope = {
    tenant,
    actorId: actor?.id,
    subject: subject.name,
    actorEntity: rows?.entity.$name,
  };
  const lookup = seededIds(graph, options.entities, { ...scope, self });
  const drawn = bindIds(drawInput(sampler, subject.input, 0, 0), lookup);
  const bindInput = overrideInput(subject.name, override);
  const given = bindInput === undefined ? drawn : await bindInput(drawn, actor);
  return { actor, input: seatIn(subject, given, tenant) };
}

/** The records with both sweeps' verdicts and scale time on them, and each sweep's whole time. */
export interface Swept {
  readonly records: readonly ExerciseRecord[];
  readonly ms: Pick<ExercisePhaseMs, 'scale' | 'plans'>;
}

/** `subject`'s calls, each timed into `spent` under its name: the sweep calls it once per size. */
const timed = (subject: ScaleSubject, spent: Map<string, number>): ScaleSubject => ({
  ...subject,
  call: async (...args) => {
    const started = performance.now();
    try {
      return await subject.call(...args);
    } finally {
      spent.set(subject.name, (spent.get(subject.name) ?? 0) + performance.now() - started);
    }
  },
});

/**
 * The scale sweep inside the room, the room closed, then the plan sweep — on the installed client
 * only: with none, the pass ran on a driver that sends no SQL and there is no plan to read.
 */
export async function attachSweeps(
  records: readonly ExerciseRecord[],
  options: ScaleSweepOptions,
): Promise<Swept> {
  const spent = new Map<string, number>();
  let scale: Awaited<ReturnType<typeof scaleSweep>>;
  const scaleStarted = performance.now();
  try {
    scale = await scaleSweep({
      ...options,
      subjects: options.subjects.map((subject) => timed(subject, spent)),
    });
  } finally {
    await options.room[Symbol.asyncDispose]();
  }
  const plansStarted = performance.now();
  const db = await import('@ultimat3/db');
  const plans = db.dbClientInstalled()
    ? await sweepPlans(db.db(), options.room.sent(), options.entities)
    : new Map();
  const ms = {
    scale: Math.round(plansStarted - scaleStarted),
    plans: Math.round(performance.now() - plansStarted),
  };
  const swept = records.map((record) => {
    const proof = plans.get(record.name);
    const sized = scale.get(record.name);
    const scaleMs = spent.get(record.name);
    const proofMs = {
      ...record.proofMs,
      ...(scaleMs === undefined ? {} : { scale: Math.round(scaleMs) }),
    };
    return {
      ...record,
      ...(proof === undefined ? {} : { plans: proof }),
      ...(sized === undefined ? {} : { scale: sized }),
      ...(Object.keys(proofMs).length === 0 ? {} : { proofMs }),
    };
  });
  return { records: swept, ms };
}
