// A drill's write lane: the app's actions an anonymous caller may POST, each request carrying a
// fresh input drawn as the exercise pass draws one (the seeded draw, then the app's `exercise.ts`
// override). It is how a drill's load reaches the queue — a job enqueued over HTTP is what
// `worker-sigkill` and `worker-sigterm` need on the table to have anything to reclaim.

import { bindDrawn } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ExerciseOverrides } from './define-exercise';
import type { DrillTarget } from './drill-load';
import type { Sampler } from './exercise-input';
import { loadSampler } from './exercise-input';

/** The seed every drill draws under: one run's inputs are the same on every machine. */
export const DRILL_DRAW_SEED = 40;

/** An action as the served route table states it. */
export interface DrillWriteCandidate {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  /** The policy admits a caller with no session (`auth: 'public'` on its route). */
  readonly anonymous: boolean;
  readonly input: StandardSchemaV1;
}

export interface DrillWritesOptions {
  readonly actions: readonly DrillWriteCandidate[];
  readonly overrides?: ExerciseOverrides | undefined;
  /** The exercise pass's own sampler, loaded on demand when not handed in. */
  readonly sampler?: Pick<Sampler, 'arbitrary'> | undefined;
}

export interface DrillWrites {
  readonly targets: readonly DrillTarget[];
  /** Every action left out, and why: printed, so an empty lane is never a silent one. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

type Verdict =
  | { readonly reason: string }
  | { readonly bind: ((drawn: unknown) => unknown) | undefined };

/** Why `candidate` cannot ride an anonymous load, or the override that binds its input. */
function verdictOf(
  candidate: DrillWriteCandidate,
  overrides: ExerciseOverrides | undefined,
): Verdict {
  if (candidate.method !== 'POST') return { reason: `answers ${candidate.method}; the load posts` };
  if (/[:*]/.test(candidate.path))
    return { reason: 'its path takes a parameter the load cannot bind' };
  if (!candidate.anonymous) return { reason: 'its policy refuses an anonymous caller' };
  const override = overrides?.entries.get(candidate.name);
  if (override === undefined) return { bind: undefined };
  if ('off' in override) return { reason: `exercise.ts turns it off: ${override.off.trim()}` };
  if (override.actor !== null) return { reason: 'exercise.ts runs it as a signed-in actor' };
  return { bind: bindDrawn(override.input) };
}

/** The write targets of an anonymous load, and every action it leaves out. */
export async function drillWriteTargets(options: DrillWritesOptions): Promise<DrillWrites> {
  const sampler = options.sampler ?? (await loadSampler());
  const targets: DrillTarget[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const candidate of options.actions) {
    const verdict = verdictOf(candidate, options.overrides);
    if ('reason' in verdict) {
      skipped.push({ name: candidate.name, reason: verdict.reason });
      continue;
    }
    const { bind } = verdict;
    targets.push({
      method: 'POST',
      path: candidate.path,
      // Run n of the seeded draw: a distinct input per request, so a job keyed by its input is a
      // distinct job — the same body every time is one job deduped, and nothing to reclaim.
      draw: (run) => {
        const drawn = sampler.arbitrary(candidate.input, { seed: DRILL_DRAW_SEED, run });
        return bind === undefined ? drawn : bind(drawn);
      },
    });
  }
  return { targets, skipped };
}
