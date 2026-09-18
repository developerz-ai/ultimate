// Single responsibility: whether `x dev` must declare `ULTIMATE_ENV` for the app it is about to
// boot, and the one-liner side effect that declares it. Split out of `cmd-dev.ts` (which the
// filesize gate holds to ~500 lines) rather than folded into it — this is one decision with one
// consumer, and keeping it separate is what lets a test pin the decision without paying for a
// whole app boot.

import { ENVIRONMENT_KEY } from '@ultimat3/core';

/**
 * Whether `x dev` must declare `ULTIMATE_ENV` for the app it is about to boot: true only when
 * NEITHER key `@ultimat3/core`'s `resolveEnvironment` reads is set to a real value. Empty-string
 * matches that reader's own rule (`packages/core/src/environment.ts`'s `readEnvironment`):
 * `ULTIMATE_ENV=''` is treated as unset, so "already set" here means non-empty, exactly as there.
 *
 * `NODE_ENV=ci` (or any other non-`Environment` value) counts as "already set" and is left alone
 * even though `resolveEnvironment` would still fall through it to `DEFAULT_ENVIRONMENT` — an
 * operator who set SOMETHING gets no override from this process, only a process that named
 * NEITHER key does.
 */
export function needsDevEnvironmentDeclaration(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const declared = env[ENVIRONMENT_KEY];
  const nodeEnv = env['NODE_ENV'];
  return (declared === undefined || declared === '') && (nodeEnv === undefined || nodeEnv === '');
}

/**
 * The one-liner side effect, split from the decision so a test can pin either without paying for
 * a whole app boot: `process.env[ENVIRONMENT_KEY] = 'development'`, and only when
 * `needsDevEnvironmentDeclaration` says neither key was set.
 *
 * Mutates the real `process.env`, not a copy: `cmd-dev.ts`'s `run` passes `ctx.env`, which IS
 * `Bun.env` (probed on 1.4.2 — `Bun.env === process.env`), and it is `process.env` that
 * `resolveEnvironment`'s default reader (no explicit `env` passed) and every app module loaded
 * in-process actually consult. The call has to land before `startDev` imports a single app
 * module — see `cmd-dev.ts`'s `run` for why that means the top of the command, not inside
 * `startDev` itself, which stays a pure function of the `env` it is handed.
 */
export function declareDevEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if (needsDevEnvironmentDeclaration(env)) process.env[ENVIRONMENT_KEY] = 'development';
}
