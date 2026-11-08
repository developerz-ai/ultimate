// The crash proof, as the exercise pass runs it: a job its control reached is killed at every step
// boundary with the control's own input and actor (`crashProof`), and the answer is a plain record
// `.x/exercise.json` can hold. Run after the control, so its runs meet the rows the control left.

import type { Actor } from '@ultimat3/core';
import { ctxOf, isUltimateError, renderThrowable } from '@ultimat3/core';
import type { AnyJobHandle } from '@ultimat3/jobs';
import type { CrashFinding, CrashProof } from './exercise-report';
import type { CrashDivergence } from './job-crash-proof';
import { crashProof } from './job-crash-proof';

const findingOf = (divergence: CrashDivergence): CrashFinding => {
  const after = divergence.error.meta?.['after'];
  return {
    boundary: divergence.boundary,
    mode: divergence.mode,
    effect: divergence.effect,
    clean: divergence.clean,
    killed: divergence.killed,
    ...(typeof after === 'string' ? { after } : {}),
    ...(divergence.inside === undefined ? {} : { inside: divergence.inside }),
  };
};

/**
 * `diverged` is red; `unproven` — the proof itself could not finish — is reported, never red, as
 * the tenant proof's is: a question the pass could not ask is not an answer.
 */
export async function proveCrash(
  handle: AnyJobHandle,
  input: unknown,
  actor: Actor | null,
): Promise<CrashProof> {
  const worker = ctxOf(actor === null ? { role: 'worker' } : { role: 'worker', actor });
  try {
    const report = await crashProof(handle, input, { context: () => worker });
    const counted = { boundaries: report.boundaries.length, reruns: report.reruns.length };
    return report.divergences.length === 0
      ? { verdict: 'held', ...counted }
      : { verdict: 'diverged', ...counted, findings: report.divergences.map(findingOf) };
  } catch (error) {
    return {
      verdict: 'unproven',
      reason: isUltimateError(error) ? `${error.code}: ${error.cause}` : renderThrowable(error),
    };
  }
}
