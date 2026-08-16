// Single responsibility: which named environment this process is running as. ONE concept, one
// key (`ULTIMATE_ENV`), one spelling per value — the twin of `roles.ts`: `ROLE` says what the
// process does, `ULTIMATE_ENV` says which deploy it belongs to.

import { type CodedErrorInit, UltimateError } from './errors';

export class EnvironmentInvalidError extends UltimateError {
  static readonly code = 'X_ENVIRONMENT_INVALID';
  override readonly name = 'EnvironmentInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: EnvironmentInvalidError.code });
  }
}

/**
 * The spellings are `NODE_ENV`'s, plus `staging`. Inventing `dev`/`prod` aliases would mean two
 * ways to write one environment, and `NODE_ENV=production` — which every container image and
 * platform already sets — would have to be translated at every read.
 */
export const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export const DEFAULT_ENVIRONMENT: Environment = 'development';

/** The one key. `NODE_ENV` is read only as a fallback, because platforms set it for us. */
export const ENVIRONMENT_KEY = 'ULTIMATE_ENV';

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}

export interface ResolveEnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fallback?: Environment | undefined;
}

/** One read of the two keys, so the throwing and the non-throwing entry point cannot disagree. */
type EnvironmentRead =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly declared: string };

function readEnvironment(options?: ResolveEnvironmentOptions): EnvironmentRead {
  const source = options?.env ?? (process.env as Record<string, string | undefined>);
  const declared = source[ENVIRONMENT_KEY];
  if (declared !== undefined && declared !== '') {
    return isEnvironment(declared) ? { ok: true, environment: declared } : { ok: false, declared };
  }
  const inherited = source['NODE_ENV'];
  if (isEnvironment(inherited)) return { ok: true, environment: inherited };
  return { ok: true, environment: options?.fallback ?? DEFAULT_ENVIRONMENT };
}

/**
 * `ULTIMATE_ENV`, else `NODE_ENV`, else `development`.
 *
 * A set-but-unknown `ULTIMATE_ENV` throws: it is the framework's key, so a typo in it is always a
 * mistake, exactly as `resolveRole()` treats `ROLE`. A set-but-unknown `NODE_ENV` does not throw —
 * it is not ours to police, and CI images set it to values ("ci", "qa") that must not stop a boot.
 */
export function resolveEnvironment(options?: ResolveEnvironmentOptions): Environment {
  const read = readEnvironment(options);
  if (read.ok) return read.environment;
  throw new EnvironmentInvalidError({
    cause: `${ENVIRONMENT_KEY}="${read.declared}" is not one of ${ENVIRONMENTS.join(' | ')}`,
    fix: `export ${ENVIRONMENT_KEY}=${ENVIRONMENTS.join('|')} — one of those exact values`,
    meta: { key: ENVIRONMENT_KEY, received: read.declared, allowed: ENVIRONMENTS },
  });
}

/**
 * The same resolution for a caller that must answer rather than fail — a response being rendered,
 * a report being tagged. `undefined` means exactly one thing: `ULTIMATE_ENV` is set to something
 * that is not an environment, the one case `resolveEnvironment` throws on. Every other input
 * answers identically, so the key still has one reader and only the failure policy differs.
 *
 * The caller names its own fallback (`?? DEFAULT_ENVIRONMENT`) rather than getting one here: a
 * process that cannot say which deploy it is has a policy about that, and it is never this file's.
 */
export function tryResolveEnvironment(
  options?: ResolveEnvironmentOptions,
): Environment | undefined {
  const read = readEnvironment(options);
  return read.ok ? read.environment : undefined;
}

/** The one production test. Anything that is not literally `production` is not production. */
export function isProduction(options?: ResolveEnvironmentOptions): boolean {
  return resolveEnvironment(options) === 'production';
}

/**
 * True where a shipped development default (a signing key, a stub driver, an open CORS rule) is
 * still acceptable. `staging` is deliberately NOT included: staging exists to fail the way
 * production fails.
 */
export function isLocal(options?: ResolveEnvironmentOptions): boolean {
  const environment = resolveEnvironment(options);
  return environment === 'development' || environment === 'test';
}
