// The eval facts `x verify` reads: recording is off, every prompt has an eval, and every eval has
// a baseline it can actually gate against.
//
// All three come from the app's own registries and from `@ultimat3/ai`'s own reader — never from a
// filename, so renaming a file cannot silently un-gate a prompt, and never from a second baseline
// parser, so the gate and the suite can never disagree about what a recorded score is.

import {
  baselinePath,
  describeEvals,
  EvalBaselineMissingError,
  EvalMissingError,
  EvalRecordingError,
  promptsWithoutEvals,
  RECORD_ENV,
  readBaseline,
  recordingBaselines,
} from '@ultimat3/ai';
import { loadApp } from './app-load';
import type { Finding } from './output';
import { findingFrom } from './output';

/**
 * Recording makes every eval write the numbers it just measured and pass, so a gate run that
 * inherited the flag is green over scores nothing compared — and rewrites the committed baselines
 * on its way through. The step refuses before the suite runs, because a red step alone would not
 * undo the rewrite.
 */
export function checkEvalRecording(): readonly Finding[] {
  if (!recordingBaselines()) return [];
  return [{ ...findingFrom(new EvalRecordingError({ env: RECORD_ENV })), at: RECORD_ENV }];
}

/** Every prompt an app registers must be named by an eval. */
export async function checkEvalCoverage(root: string): Promise<readonly Finding[]> {
  // Loading is idempotent per process: `x verify` loads the app once and every later step,
  // including the manifest, reads the same registries.
  await loadApp(root);
  return promptsWithoutEvals().map((prompt) => ({
    ...findingFrom(new EvalMissingError({ prompt: prompt.ref, id: prompt.id })),
    at: prompt.ref,
  }));
}

/**
 * Every eval must have a baseline on disk that reads back. Without this the gate asks only whether
 * a `defineEval` exists, and an eval whose numbers were never recorded — one no test asserts, one
 * whose `baseline:` is a cwd-relative string — passes it while gating on nothing.
 */
export async function checkEvalBaselines(root: string): Promise<readonly Finding[]> {
  await loadApp(root);
  const findings: Finding[] = [];
  for (const fact of describeEvals()) {
    // `baselinePath` refuses a spec that is not `import.meta.resolve('./…')`, and `readBaseline`
    // refuses a file that is not a baseline; both say so as the eval's own X_* code.
    try {
      const path = baselinePath(fact.baseline, fact.name);
      if ((await readBaseline(path)) !== undefined) continue;
      findings.push({
        ...findingFrom(
          new EvalBaselineMissingError({
            eval: fact.name,
            path,
            reason: 'has never been recorded',
          }),
        ),
        at: fact.name,
      });
    } catch (error) {
      findings.push({ ...findingFrom(error), at: fact.name });
    }
  }
  return findings;
}
