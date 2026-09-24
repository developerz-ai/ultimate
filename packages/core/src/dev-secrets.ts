// Single responsibility: the boot refusal of a shipped development signing secret outside a local
// environment. `x doctor` reported it; nothing failed — so a production pod that forgot
// ULTIMATE_CURSOR_SECRET signed every cursor with a key published in this package.

import { usesDevCursorSecret } from './cursor';
import { isLocal } from './environment';
import { UltimateError } from './errors';

/**
 * `X_CURSOR_SECRET_DEV`, the code `x doctor` already reports for this key — one condition, one code.
 * Doctor warns; this refuses the boot.
 */
export class CursorSecretDevError extends UltimateError {
  static readonly code = 'X_CURSOR_SECRET_DEV';
  override readonly name = 'CursorSecretDevError';

  // One secret today, so the fix is a literal: a spliced name would be a value in a pasted command.
  constructor() {
    super({
      code: CursorSecretDevError.code,
      cause:
        'ULTIMATE_CURSOR_SECRET is unset, so this process signs cursors with the development key the framework ships — anyone can forge a page position',
      fix: "x secrets set ULTIMATE_CURSOR_SECRET — or export ULTIMATE_CURSOR_SECRET from the platform's secret store",
      meta: { variable: 'ULTIMATE_CURSOR_SECRET' },
    });
  }
}

export interface DevSecretsOptions {
  /** Which environment the boot is — defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Throws when a shipped dev secret is in use and the environment is not `development`/`test`.
 *
 * FAILS CLOSED: a process with neither `ULTIMATE_ENV` nor `NODE_ENV` resolves as `production`
 * here, the answer `templates/scaffold-auth.ts` already gives — `isLocal()`'s own fallback is
 * `development`, which is exactly the process that forgot to say. The secret itself is read where
 * signing reads it, so this refuses what the process WILL sign with, not what `env` claims.
 */
export function assertNoDevSecretsOutsideLocal(options: DevSecretsOptions = {}): void {
  if (isLocal({ env: options.env, fallback: 'production' })) return;
  if (usesDevCursorSecret()) throw new CursorSecretDevError();
}
