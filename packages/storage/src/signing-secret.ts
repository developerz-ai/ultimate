// Single responsibility: the secret a disk that mints its OWN URLs signs with — the published
// development fallback, the env key production must set, and the one rule (`localDriver` and
// `memoryStorageDriver` both) for refusing the fallback outside a development or test environment.

import { isLocal, type ResolveEnvironmentOptions, resolveEnvironment } from '@ultimat3/core';
import { signingSecretMissing } from './errors';

/**
 * The dev-only fallback signing key. A literal, not a per-process random one, so a restart does
 * not invalidate every URL `x dev` handed out — and published in this repo, which is exactly why
 * `localDriver` refuses to use it outside a development or test environment.
 */
export const DEV_SIGNING_SECRET = 'ultimate-dev-signing-secret';

/** The env key production must set. Named once, read by the driver and by the predicate below. */
export const STORAGE_SIGNING_SECRET_KEY = 'STORAGE_SIGNING_SECRET';

/**
 * True while a local disk built without an explicit `signingSecret` would sign with the shipped
 * development key — `x doctor` reports it, exactly as it reports `usesDevCursorSecret()`.
 *
 * Reads the environment, not a driver instance: this is the same question `x doctor` asks about
 * the cursor secret, and a disk handed an explicit `signingSecret` in `app.config.ts` never
 * consults the variable at all.
 *
 * `env` is core's own slot, so this half of the guard reads the SAME table its other half does:
 * `dev-runtime.ts` asks `!isLocal({ env }) && usesDevStorageSecret({ env })`, and an embedding
 * caller (`serveApp({ env })`, a test fixture) whose `env` is not `process.env` used to get one
 * answer about the boot and one about the process — for the decision of whether a disk may be
 * signed with the published development key. Defaulted to `process.env`, so a bare call is
 * unchanged.
 */
export function usesDevStorageSecret(options?: Pick<ResolveEnvironmentOptions, 'env'>): boolean {
  const source = options?.env ?? (process.env as Record<string, string | undefined>);
  const configured = source[STORAGE_SIGNING_SECRET_KEY];
  return configured === undefined || configured === '' || configured === DEV_SIGNING_SECRET;
}

/** The two options the rule reads; `LocalDriverOptions` carries both. */
export interface SigningSecretOptions {
  readonly signingSecret?: string | undefined;
  readonly env?: ResolveEnvironmentOptions['env'];
}

/**
 * The secret a disk that mints its OWN URLs signs with — `localDriver` and `memoryStorageDriver` both.
 *
 * A dev disk must work with zero config. Outside development the fallback is refused rather than
 * used: the literal is published, so signing with it hands every reader the power to mint a PUT
 * for any key with any size and type limit — which `acceptSignedUpload` then trusts over the app's
 * own `uploadPolicy`. Refused at construction, so the boot fails rather than the first upload.
 *
 * The published literal counts as no secret at all, whichever way it arrives: an env var or an
 * `app.config.ts` that pasted it in signs exactly as weakly as the fallback does. One table for
 * all three reads — the secret, the environment test and the environment the refusal names.
 * Splitting them is how the guard and the disk came to answer about two different processes.
 */
export function resolveSigningSecret(disk: string, options: SigningSecretOptions): string {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const supplied = options.signingSecret ?? env[STORAGE_SIGNING_SECRET_KEY];
  const configured =
    supplied === undefined || supplied === '' || supplied === DEV_SIGNING_SECRET
      ? undefined
      : supplied;
  // FAILS CLOSED: a process that names no environment resolves as `production` here, the answer
  // core's `assertNoDevSecretsOutsideLocal` gives. `isLocal`'s own fallback is `development`, so the
  // process that forgot to say signed with the published key — exactly the one that must not.
  if (configured === undefined && !isLocal({ env, fallback: 'production' }))
    throw signingSecretMissing(resolveEnvironment({ env, fallback: 'production' }), disk);
  return configured ?? DEV_SIGNING_SECRET;
}
