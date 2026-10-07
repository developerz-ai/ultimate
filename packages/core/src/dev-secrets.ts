// Single responsibility: the boot refusal of a shipped development signing secret outside a local
// environment. `x doctor` reported it; nothing failed — so a production pod that forgot
// ULTIMATE_CURSOR_SECRET signed every cursor with a key published in this package.

import { CURSOR_SECRET_FIX, CURSOR_SECRET_KEY, usesDevCursorSecret } from './cursor';
import { isLocal } from './environment';
import { UltimateError } from './errors';

/**
 * `X_CURSOR_SECRET_DEV`, the code `x doctor` already reports for this key — one condition, one code.
 * Doctor warns; this refuses the boot.
 */
export class CursorSecretDevError extends UltimateError {
  static readonly code = 'X_CURSOR_SECRET_DEV';
  override readonly name = 'CursorSecretDevError';

  // The key and the fix are `cursor.ts`'s constants, never spelled here: `x doctor` and
  // `x env check` report this code with `CURSOR_SECRET_FIX` too, and one code has one fix.
  constructor() {
    super({
      code: CursorSecretDevError.code,
      cause: `${CURSOR_SECRET_KEY} is unset or empty, so this process signs cursors with the development key the framework ships — anyone can forge a page position`,
      fix: CURSOR_SECRET_FIX,
      meta: { variable: CURSOR_SECRET_KEY },
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
  if (!devSecretsRefused(options)) return;
  if (usesDevCursorSecret()) throw new CursorSecretDevError();
}

/**
 * THE rule for whether an environment refuses a shipped development secret: anything but
 * `development`/`test`, and a table naming no environment counts as production (fails closed).
 * The boot asks it above; `@ultimat3/cli` asks it of a deploy's table (`x env check`, `x doctor`),
 * so a diagnostic cannot call green an environment the boot refuses. Throws
 * `X_ENVIRONMENT_INVALID` on an unknown `ULTIMATE_ENV`, as the boot does.
 */
export function devSecretsRefused(options: DevSecretsOptions = {}): boolean {
  return !isLocal({ env: options.env, fallback: 'production' });
}
