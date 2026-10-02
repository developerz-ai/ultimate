// One finished gate step as one line of JSON, for stderr. `x verify --json` prints its document
// when the run ENDS, so a job cancelled mid-run used to leave a log with nothing in it (#589):
// the last of these lines is the last step that finished, and the hung one is whichever is next.

import type { StepResult } from './output';

/** `{"step":"lint","ok":true,"ms":21987}` — plus `"skipped":true` for a step that did not apply. */
export const stepLine = (step: StepResult): string =>
  JSON.stringify({
    step: step.name,
    ok: step.ok,
    ms: step.durationMs,
    ...(step.skipped === true ? { skipped: true } : {}),
  });

/**
 * The `onStep` a `--json` run streams through, or nothing: the human render needs no second
 * channel. One function for both entries (`x verify`, and `bun run verify` at the framework
 * root), so the two cannot print different lines.
 */
export const stepStream = (
  json: boolean,
  write: (line: string) => void,
): { readonly onStep?: (step: StepResult) => void } =>
  json ? { onStep: (step) => write(stepLine(step)) } : {};
