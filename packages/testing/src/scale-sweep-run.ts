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
import { scaleGraph } from './scale-sweep-graph';
import type { SeedGraph, SeedWriter } from './seed-graph-plan';
import { insertSeedGraph } from './seed-graph-plan';
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
}

type Call = { readonly shapes: readonly StatementTally[] } | { readonly failed: string };

async function callAt(
  subject: ScaleSubject,
  graph: SeedGraph,
  tenant: string,
  options: ScaleSweepOptions,
  self: boolean,
): Promise<Call> {
  let prepared: Awaited<ReturnType<ScaleSetup>>;
  try {
    prepared = await options.setup(subject, graph, tenant, self);
  } catch (error) {
    // An override's input is the app's code, run against this sized graph: its failure is this
    // call's, never the sweep's.
    return { failed: `its exercise.ts input threw: ${renderThrowable(error)}` };
  }
  if (prepared === undefined) return { failed: 'no actor its policy permits' };
  await using jobs = await testJobs();
  options.room.begin();
  try {
    const answer = await subject.call(prepared.input, prepared.actor, tenant, jobs);
    const observed = options.room.end();
    return 'failure' in answer ? { failed: renderThrowable(answer.failure) } : observed;
  } catch (error) {
    options.room.end();
    return { failed: renderThrowable(error) };
  }
}

/** Seed both sizes, call each subject at each, judge. Unseedable: every subject `unproven`. */
export async function scaleSweep(
  options: ScaleSweepOptions,
): Promise<ReadonlyMap<string, ScaleProof>> {
  const proofs = new Map<string, ScaleProof>();
  if (options.subjects.length === 0) return proofs;
  const sizes = [SCALE_SIZES.small, SCALE_SIZES.large].map((perTable, i) =>
    // Hashed, never `seed + 1`: a later pass on the same database may be seeded with that number.
    scaleGraph(options.main, options.entities, {
      perTable,
      seed: fnv1a(`scale:${options.seed}:${i}`) || 1,
    }),
  );
  try {
    for (const size of sizes) await insertSeedGraph(size.write, options.writer);
  } catch (error) {
    const reason = `the sized seed did not write: ${renderThrowable(error)}`;
    for (const subject of options.subjects)
      proofs.set(subject.name, { verdict: 'unproven', reason });
    return proofs;
  }
  const runs: Call[][] = [];
  // The reading that answered at the small size is the one the large size repeats.
  const selves = options.subjects.map(() => true);
  for (const [at, size] of sizes.entries()) {
    const calls: Call[] = [];
    for (const [i, subject] of options.subjects.entries()) {
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
  options.subjects.forEach((subject, i) => {
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
