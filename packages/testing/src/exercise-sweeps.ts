// What runs after every primitive's own call: the scale sweep (each reached one again, at 2 and at 8
// rows a table) and the plan sweep (every statement the pass sent, planned on the migrated
// database). Both verdicts land on the record of the primitive that sent the statements.

import type { Actor } from '@ultimat3/core';
import { bindDrawn } from '@ultimat3/core';
import type { Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ExerciseOverrides } from './define-exercise';
import type { ActorRows, RoleGrants } from './exercise-actor';
import { asSeededRow, chooseActor } from './exercise-actor';
import type { Sampler } from './exercise-input';
import { bindIds, drawInput, seededIds } from './exercise-input';
import type { ExerciseRecord } from './exercise-report';
import { sweepPlans } from './plan-sweep';
import type { ScaleSweepOptions } from './scale-sweep-run';
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

/** A primitive as a sized call needs it: its schema and its policy. */
interface Callable {
  readonly name: string;
  readonly input: StandardSchemaV1;
  readonly policy: Policy | undefined;
  readonly permissions: readonly string[];
}

/** One call of `subject` in `tenant` of a sized graph: the control's actor and first input. */
export function sizedCall(
  subject: Callable,
  options: CallOptions,
  sampler: Sampler,
  at: { readonly graph: SeedGraph; readonly tenant: string; readonly self: boolean },
): { readonly actor: Actor | null; readonly input: unknown } | undefined {
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
  const bindInput = bindDrawn(
    override !== undefined && 'actor' in override ? override.input : undefined,
  );
  return { actor, input: bindInput === undefined ? drawn : bindInput(drawn) };
}

/**
 * The scale sweep inside the room, the room closed, then the plan sweep — on the installed client
 * only: with none, the pass ran on a driver that sends no SQL and there is no plan to read.
 */
export async function attachSweeps(
  records: readonly ExerciseRecord[],
  options: ScaleSweepOptions,
): Promise<readonly ExerciseRecord[]> {
  let scale: Awaited<ReturnType<typeof scaleSweep>>;
  try {
    scale = await scaleSweep(options);
  } finally {
    await options.room[Symbol.asyncDispose]();
  }
  const db = await import('@ultimat3/db');
  const plans = db.dbClientInstalled()
    ? await sweepPlans(db.db(), options.room.sent(), options.entities)
    : new Map();
  return records.map((record) => {
    const proof = plans.get(record.name);
    const sized = scale.get(record.name);
    return {
      ...record,
      ...(proof === undefined ? {} : { plans: proof }),
      ...(sized === undefined ? {} : { scale: sized }),
    };
  });
}
