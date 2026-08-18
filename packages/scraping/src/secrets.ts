// Secrets in a browser run, and the one place this package decides what may leave it.
//
// A scrape logs in. That means a password crosses this package on its way into a form field, and
// there are exactly three ways it gets out: an event stream, a log line, and — the one nobody
// remembers — a SCREENSHOT of the filled form. The first two are solved by carrying the value in
// core's `Secret` box, which renders `[redacted]` through `String`, `JSON.stringify` and the
// logger. The third is not, because pixels cannot be redacted after the fact.

import type { Secret } from '@ultimat3/core';
import { revealSecret, secret, UltimateError } from '@ultimat3/core';

export interface ScrapeSecrets {
  readonly names: readonly string[];
  /** The boxed value. Reading it out is `revealSecret()`, one greppable call site. */
  get(name: string): Secret;
}

/**
 * Names only ever reach a job payload — the values are resolved in the worker, per attempt, from
 * the environment. A queue row that carried the value would put a bank password in a durable
 * table, in the outbox, and in every `x jobs show` an operator runs.
 */
export type SecretResolver = (name: string) => string | undefined;

const fromEnvironment: SecretResolver = (name) => Bun.env[name];

export function createSecretBag(
  names: readonly string[],
  resolve: SecretResolver = fromEnvironment,
): ScrapeSecrets {
  const boxed = new Map<string, Secret>();
  for (const name of names) {
    const value = resolve(name);
    if (value === undefined || value === '') {
      throw new UltimateError({
        code: 'X_ENV_MISSING',
        cause: `scrape secret "${name}" is declared and the environment has no value for it`,
        fix: `add ${name}= to .env.local, or drop "${name}" from secrets: on the scrape() definition`,
        meta: { name },
      });
    }
    boxed.set(name, secret(value, name));
  }
  return {
    names: [...names],
    get(name: string): Secret {
      const found = boxed.get(name);
      if (found === undefined) {
        throw new UltimateError({
          code: 'X_ENV_MISSING',
          cause: `scrape secret "${name}" was read and never declared`,
          fix: `add "${name}" to secrets: on the scrape() definition — a run resolves only what it declares`,
          meta: { name },
        });
      }
      return found;
    },
  };
}

export const SECRET_PLACEHOLDER = '[redacted]';

/**
 * Redaction BY VALUE, over any text this package is about to persist: page HTML, a console line,
 * a request URL, an error cause. Name-based redaction only catches a secret travelling under a
 * name somebody remembered to list, and a password pasted into a query string travels under none.
 *
 * Longest first, so a secret that contains another one does not leave its tail behind.
 */
export function redactSecrets(text: string, secrets: ScrapeSecrets | undefined): string {
  if (secrets === undefined || secrets.names.length === 0) return text;
  const values = secrets.names
    .map((name) => revealSecret(secrets.get(name)))
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join(SECRET_PLACEHOLDER);
  return out;
}

/** `<input type="password" value="hunter2">` -> `value=""`, whatever the value happened to be. */
export function blankPasswordFields(html: string): string {
  return html.replaceAll(
    /(<input\b[^>]*\btype\s*=\s*['"]?password['"]?[^>]*?)\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi,
    '$1value=""',
  );
}

/** Both passes, in the order that matters: value redaction first, then the structural blank. */
export const safeHtml = (html: string, secrets: ScrapeSecrets | undefined): string =>
  blankPasswordFields(redactSecrets(html, secrets));
