// `x new <name>`'s last refusal before a byte lands: the slug must be a name core's `defineConfig`
// accepts, because it is written verbatim as `app.config.ts`'s `name:` and spelled into every
// identifier the scaffold derives (`<app>Seed`). The rule is asked of core, never restated here.

import { defineConfig, isUltimateError, renderThrowable, UltimateError } from '@ultimat3/core';

/**
 * Why core's own config validator refuses `name`, in core's words, or `undefined` when it accepts
 * it — asked by building the one config that name would scaffold, every other field defaulted. A
 * copy of core's pattern here would be a second answer to "what is an app name", and the day one
 * of them moved `x new` would again write an app whose `app.config.ts` throws at its own import.
 */
export function appNameIssue(name: string): string | undefined {
  try {
    defineConfig({ name });
    return undefined;
  } catch (error) {
    return isUltimateError(error) ? error.cause : renderThrowable(error);
  }
}

/** The bound the suggestion trims an over-long slug to — re-proved by `appNameIssue`, not trusted. */
const MAX_LENGTH = 64;

/**
 * A slug core accepts, as close to `slug` as one edit gets: a leading digit gains an `app-` prefix
 * (an identifier cannot start with one either), a one-letter name an `-app` suffix, and an
 * over-long one is cut at the bound. `undefined` when none of those land on a valid name.
 */
export function suggestAppName(slug: string): string | undefined {
  let candidate = /^[0-9]/.test(slug) ? `app-${slug}` : slug;
  if (candidate.length < 2) candidate = `${candidate}-app`;
  candidate = candidate.slice(0, MAX_LENGTH).replace(/-+$/, '');
  return appNameIssue(candidate) === undefined ? candidate : undefined;
}

/** `x new 9lives`, `x new a`: a slug core's `defineConfig` would refuse at the app's first boot. */
export class AppNameInvalidError extends UltimateError {
  constructor(input: {
    name: string;
    slug: string;
    issue: string;
    invocation: string;
    flags: readonly string[];
  }) {
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `"${input.name}" scaffolds the app name "${input.slug}", which app.config.ts's defineConfig refuses: ${input.issue}`,
      fix: [input.invocation, suggestAppName(input.slug) ?? '<name>', ...input.flags].join(' '),
    });
  }
}
