// How `x g sign-in` is spelled: exactly one of `--oidc <provider>` or `--password`, and no `<name>`
// — an app has one sign-in, so there is nothing to name. Both flags are refused on every other
// generator: a flag accepted and ignored is a second spelling an agent believes did something.

import { BUILTIN_OAUTH_PROVIDER_IDS } from '@ultimat3/auth';
import { generateSpec } from './cmd-generate-spec';
import { BadFlagError } from './errors';
import type { Generator } from './generate-kinds';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';

export type SignInMode =
  | { readonly kind: 'password' }
  | { readonly kind: 'oidc'; readonly provider: string };

/** A provider id is one URL segment and two env-key prefixes: lowercase, digits, hyphens. */
const PROVIDER = /^[a-z][a-z0-9-]{0,62}$/;

/** What a run is called in its summary line: `password`, or the provider. */
export const signInLabel = (mode: SignInMode): string =>
  mode.kind === 'password' ? 'password' : mode.provider;

/** The two flags, on a generator that is not `sign-in`, refused before anything is planned. */
export function refuseSignInFlags(kind: Generator, args: ParsedArgs): void {
  if (kind === 'sign-in') return;
  for (const flag of ['oidc', 'password']) {
    if (!args.flags.has(flag)) continue;
    throw new BadFlagError({
      flag,
      command: `g ${kind}`,
      reason: `--${flag} is the sign-in generator's`,
      fix: flag === 'oidc' ? 'x g sign-in --oidc corp-sso' : 'x g sign-in --password',
    });
  }
}

/** The `x g` flags the sign-in generator reads; every other one would be ignored, so is refused. */
const SIGN_IN_READS = new Set(['oidc', 'password', 'force', 'dry-run', 'locales']);

/**
 * Any other `x g` flag set to something but its default: the generator never reads `--feature`,
 * `--surface`, `--at`, `--permission`, `--live`, `--admin` or `--locales`, so each would be a
 * flag accepted and ignored — the second spelling the header refuses.
 */
function refuseUnreadFlags(args: ParsedArgs): void {
  for (const flag of generateSpec.flags ?? []) {
    if (SIGN_IN_READS.has(flag.name)) continue;
    const value = args.flags.get(flag.name);
    if (value === undefined || value === flag.default) continue;
    throw new BadFlagError({
      flag: flag.name,
      command: 'g sign-in',
      reason: `the sign-in generator does not read --${flag.name}, so it would change nothing`,
      fix: 'x g sign-in --password',
    });
  }
}

export function readSignInMode(args: ParsedArgs): SignInMode {
  refuseUnreadFlags(args);
  const named = args.positionals[1];
  if (named !== undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: 'g sign-in',
      reason: `an app has one sign-in, so "${named}" names nothing — the shape is a flag`,
      fix: 'x g sign-in --password',
    });
  }
  const provider = flagString(args, 'oidc');
  const passwordFlag = flagBool(args, 'password');
  if ((provider === undefined) !== passwordFlag) {
    throw new BadFlagError({
      flag: passwordFlag ? 'password' : 'oidc',
      command: 'g sign-in',
      reason: passwordFlag
        ? '--password and --oidc are two sign-ins, and the generator writes one'
        : 'needs exactly one of --oidc <provider> or --password',
      fix: 'x g sign-in --password',
    });
  }
  if (provider === undefined) return { kind: 'password' };
  if (!PROVIDER.test(provider)) {
    throw new BadFlagError({
      flag: 'oidc',
      command: 'g sign-in',
      reason: `"${provider}" is not a provider id: lowercase letters, digits and hyphens, a letter first`,
      fix: 'x g sign-in --oidc corp-sso',
    });
  }
  const builtin: readonly string[] = BUILTIN_OAUTH_PROVIDER_IDS;
  if (builtin.includes(provider)) {
    throw new BadFlagError({
      flag: 'oidc',
      command: 'g sign-in',
      reason: `"${provider}" is a built-in provider, registered already; --oidc discovers a new issuer under its own id`,
      fix: 'x g sign-in --oidc corp-sso',
    });
  }
  return { kind: 'oidc', provider };
}
