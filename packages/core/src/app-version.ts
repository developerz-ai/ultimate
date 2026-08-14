// Single responsibility: which build of the APP this process is running. The third key in the
// same family as `environment.ts` (`ULTIMATE_ENV` — which deploy) and `roles.ts` (`ROLE` — what
// this process does): one key, one spelling, one default.
//
// Deliberately NOT `version.ts`. That answers what version of the FRAMEWORK shipped, read from
// `@ultimat3/core`'s own manifest; this answers what the deploy calls itself, and on every release
// that does not bump both they are different strings.

export const APP_VERSION_KEY = 'APP_VERSION';

/** An unset key is a local process, never a build nobody can name. */
export const DEFAULT_APP_VERSION = 'dev';

/**
 * `APP_VERSION`, else `dev`.
 *
 * One reader rather than one per caller because the value is DURABLE: it is written into
 * `x_migrations` rows by `@ultimat3/db` and `x_backfills` rows by `@ultimat3/jobs`, both of which
 * outlive the process that wrote them. Two packages defaulting it differently would put two names
 * on one build, in two tables an operator reads side by side. `jobs` cannot reach `db` for it —
 * `db` is tier 1 and off that package's import list — so the shared answer lives here, at tier 0.
 */
export function appVersion(
  env: Readonly<Record<string, string | undefined>> = process.env as Record<
    string,
    string | undefined
  >,
): string {
  const declared = env[APP_VERSION_KEY];
  // Empty is unset: a platform that exports the key with no value has named no build.
  return declared === undefined || declared === '' ? DEFAULT_APP_VERSION : declared;
}
