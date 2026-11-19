// The gate's two whole-tree tools, each run inside its measured reservation in the machine ledger.
// Split from `verify-checks.ts`, which owns what the steps conclude from these results.

import type { ExecResult } from './exec';
import { withCheckoutLock, withChild, withHeavy } from './heavy';
import { LINT_PEAK_MB, typecheckPeakMb } from './heavy-weights';
import { LINT_ARGV } from './lint-findings';
import type { VerifyContext } from './verify-step';

/** The compiler's peak in the ledger, then this checkout's one `tsc` at a time. */
export function runTypecheck(ctx: VerifyContext, argv: readonly string[]): Promise<ExecResult> {
  const env = ctx.env ?? Bun.env;
  return withHeavy(
    { label: 'typecheck', cwd: ctx.root, env, unitMb: typecheckPeakMb(argv) },
    (held) =>
      withCheckoutLock({ name: 'typecheck', root: ctx.root, env }, held, (child) =>
        ctx.runner(['bunx', ...argv], withChild({ cwd: ctx.root }, child)),
      ),
  );
}

export const runLint = (ctx: VerifyContext): Promise<ExecResult> =>
  withHeavy(
    { label: 'lint', cwd: ctx.root, env: ctx.env ?? Bun.env, unitMb: LINT_PEAK_MB },
    (child) => ctx.runner(LINT_ARGV, withChild({ cwd: ctx.root }, child)),
  );
