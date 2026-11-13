// The scale sweep, run: two more tenants after the pass, one at 2 rows a table and one at 8, and
// every reached primitive called once in each, in the same order — whatever an earlier call wrote,
// it wrote at both sizes. A shape whose count grows with the rows is `judgeScale`'s red.

import type { Actor } from '@ultimat3/core';
import { fnv1a, renderThrowable } from '@ultimat3/core';
import type { ExerciseRoom } from './exercise-report';
import type { RunJobs } from './fixture-jobs';
import { testJobs } from './fixture-jobs';
import type { ScaleProof, StatementTally } from './scale-sweep';
import { judgeScale, SCALE_SIZES } from './scale-sweep';
import type { ScaleGraph } from './scale-sweep-graph';
import { scaleGraph } from './scale-sweep-graph';
import { readsLost, writeSizedSeeds } from './scale-sweep-seed';
import type { SeedFactory, SeedGraph, SeedWriter } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** What the sweep needs of a primitive: the pass's own call. */
export interface ScaleSubject {
  readonly name: string;
  call(
    input: unknown,
    actor: Actor | null,
    tenant: string,
    jobs: RunJobs,
  ): Promise<{ readonly failure?: unknown }>;
}

/**
 * The pass's recipe for one call in `tenant` of `graph`: its actor and its input, or none. `self`
 * binds a field naming the actor entity to the actor's own row, else to somebody else's — the two
 * readings the control tries.
 */
export type ScaleSetup = (
  subject: ScaleSubject,
  graph: SeedGraph,
  tenant: string,
  self: boolean,
) => Promise<{ readonly actor: Actor | null; readonly input: unknown } | undefined>;

export interface ScaleSweepOptions {
  readonly subjects: readonly ScaleSubject[];
  readonly entities: readonly SeedEntity[];
  readonly writer: SeedWriter;
  readonly main: SeedGraph;
  readonly seed: number;
  readonly room: ExerciseRoom;
  readonly setup: ScaleSetup;
  /** `defineExercise`'s factories, handed to every sized graph as to the pass's own. */
  readonly factories?: Readonly<Record<string, SeedFactory>> | undefined;
}

type Call = { readonly shapes: readonly StatementTally[] } | { readonly failed: string };

async function callAt(
  subject: ScaleSubject,
  graph: SeedGraph,
  tenant: string,
  options: ScaleSweepOptions,
  self: boolean,
): Promise<Call> {
  // Before the setup: an override's input binds on the queue this call runs on, so a job it
  // enqueues is there when the call looks it up by id.
  await using jobs = await testJobs();
  let prepared: Awaited<ReturnType<ScaleSetup>>;
  try {
    prepared = await options.setup(subject, graph, tenant, self);
  } catch (error) {
    // An override's input is the app's code, run against this sized graph: its failure is this
    // call's, never the sweep's.
    return { failed: `its exercise.ts input threw: ${renderThrowable(error)}` };
  }
  if (prepared === undefined) return { failed: 'no actor its policy permits' };
  // Observed by the call's own async context: a timer's statement in its window is not its shape.
  const seen = await options.room.observe(undefined, () =>
    subject.call(prepared.input, prepared.actor, tenant, jobs),
  );
  if ('error' in seen) return { failed: renderThrowable(seen.error) };
  return 'failure' in seen.value ? { failed: renderThrowable(seen.value.failure) } : seen.observed;
}

/**
 * Seed both sizes, call each subject at each, judge. A table the sized seed could not write leaves
 * `unproven` only the subjects that read it, the failure on their proof; the rest are judged.
 */
export async function scaleSweep(
  options: ScaleSweepOptions,
): Promise<ReadonlyMap<string, ScaleProof>> {
  const proofs = new Map<string, ScaleProof>();
  if (options.subjects.length === 0) return proofs;
  const sizes: ScaleGraph[] = [];
  for (const [i, perTable] of [SCALE_SIZES.small, SCALE_SIZES.large].entries()) {
    // Hashed, never `seed + 1`: a later pass on the same database may be seeded with that number.
    // Each beside the one written before it, so no row position — and no value built from one —
    // repeats across the three graphs in the database.
    sizes.push(
      scaleGraph(options.main, options.entities, {
        perTable,
        seed: fnv1a(`scale:${options.seed}:${i}`) || 1,
        factories: options.factories,
        beside: sizes[i - 1]?.write ?? options.main,
      }),
    );
  }
  const loss = await writeSizedSeeds(
    sizes.map((size) => size.write),
    options.entities,
    options.writer,
  );
  const sent = options.room.sent();
  const subjects = options.subjects.filter((subject) => {
    const seed = readsLost(subject.name, sent, loss, options.entities);
    if (seed === undefined) return true;
    const reason = `the sized seed did not write ${seed.entity}, which it reads: ${seed.cause}`;
    proofs.set(subject.name, { verdict: 'unproven', reason, seed });
    return false;
  });
  const runs: Call[][] = [];
  // The reading that answered at the small size is the one the large size repeats.
  const selves = subjects.map(() => true);
  for (const [at, size] of sizes.entries()) {
    const calls: Call[] = [];
    for (const [i, subject] of subjects.entries()) {
      let call = await callAt(subject, size.lookup, size.tenant, options, selves[i] ?? true);
      if (at === 0 && 'failed' in call) {
        const other = await callAt(subject, size.lookup, size.tenant, options, false);
        if (!('failed' in other)) {
          call = other;
          selves[i] = false;
        }
      }
      calls.push(call);
    }
    runs.push(calls);
  }
  subjects.forEach((subject, i) => {
    const small = runs[0]?.[i];
    const large = runs[1]?.[i];
    if (small === undefined || large === undefined) return;
    if ('failed' in small || 'failed' in large) {
      const failed = 'failed' in small ? small.failed : 'failed' in large ? large.failed : '';
      proofs.set(subject.name, {
        verdict: 'unproven',
        reason: `a sized call did not answer: ${failed}`,
      });
      return;
    }
    proofs.set(subject.name, judgeScale(small.shapes, large.shapes));
  });
  return proofs;
}
