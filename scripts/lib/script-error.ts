// The throwable the root scripts use, shaped exactly like `UltimateError`: a stable code, a cause
// and an executable fix. NOT that class — `scripts/boundaries.ts` is a gate that must keep running
// with no `node_modules` present, so nothing under `scripts/lib` may import a workspace package.
//
// A bare `Error` here is the house-rule violation `packages/cli/src/exec.ts` already avoids at the
// same seam: no code, no `fix:`, and nothing a `--json` reader can act on.

import type { Finding } from './log';

export class ScriptError extends Error {
  readonly code: string;
  /** Narrowed from `Error`'s `unknown`: a scripts-side cause is always the sentence, never a value. */
  override readonly cause: string;
  readonly fix: string;

  constructor(input: { code: string; cause: string; fix: string }) {
    super(`${input.code}: ${input.cause}\n  fix:   ${input.fix}`);
    this.name = 'ScriptError';
    this.code = input.code;
    this.cause = input.cause;
    this.fix = input.fix;
  }

  /** So a caller can `report()` it on the same three lines every other finding prints. */
  toFinding(): Finding {
    return { code: this.code, cause: this.cause, fix: this.fix };
  }
}
