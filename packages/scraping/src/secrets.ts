// Secrets in a browser run, and the one place this package decides what may leave it.
//
// A scrape logs in. That means a password crosses this package on its way into a form field, and
// there are exactly three ways it gets out: an event stream, a log line, and — the one nobody
// remembers — a SCREENSHOT of the filled form. The first two are solved by carrying the value in
// core's `Secret` box, which renders `[redacted]` through `String`, `JSON.stringify` and the
// logger. The third is not, because pixels cannot be redacted after the fact.

import type { Secret } from '@ultimat3/core';
import { revealSecret, secret, UltimateError } from '@ultimat3/core';
import type { ConsoleLine, NetworkEntry, PageError } from './rings';

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
 * The floor, and it is a real hole rather than an implementation detail: a secret shorter than
 * this is NOT redacted.
 *
 * A three-character value is a substring of ordinary prose — a PIN of `123` would blank every
 * price, every id and every timestamp fragment on the page, and an artifact redacted into
 * unreadability is one nobody can diagnose from. So the bound is deliberate, and the answer for a
 * genuinely short credential is that it must not be one: `page.type(selector, secrets.get(name))`
 * still TAINTS the page whatever the length, so `screenshot()` and `pdf()` are refused either way.
 * Only the by-value text pass below skips it. Exported so a caller can check rather than discover.
 */
export const MIN_REDACTABLE_LENGTH = 4;

/**
 * Redaction BY VALUE, over the text this package hands back or persists. Name-based redaction only
 * catches a secret travelling under a name somebody remembered to list, and a password pasted into
 * a query string travels under none.
 *
 * The four surfaces, and they are the four callers below — page HTML (`safeHtml`), a console line
 * (`safeConsole`), a request URL (`safeNetwork`) and a thrown message (`safePageErrors`), plus the
 * HTTP leg's own `X_SCRAPE_HTTP_FAILED` cause, which redacts at its throw site in `http.ts`
 * because the body is gone by the time anything else could. Three of those had NO caller until
 * 2026-08-24 while this header claimed all four.
 *
 * What is still NOT redacted, stated rather than implied: a URL in any other error's `cause` or
 * `meta` (`X_SCRAPE_HOST_BLOCKED`, `X_SCRAPE_FIXTURE_MISSING`), a value shorter than
 * `MIN_REDACTABLE_LENGTH`, and pixels — which is why a secret TAINTS the page and captures are
 * refused outright.
 *
 * Longest first, so a secret that contains another one does not leave its tail behind.
 */
export function redactSecrets(text: string, secrets: ScrapeSecrets | undefined): string {
  if (secrets === undefined || secrets.names.length === 0) return text;
  const values = secrets.names
    .map((name) => revealSecret(secrets.get(name)))
    .filter((value) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join(SECRET_PLACEHOLDER);
  return out;
}

/**
 * The bounded tails, redacted on the way OUT of the page vocabulary rather than on the way into
 * the ring. A driver fills its rings from the browser's own events, and a `type()` that has not
 * happened yet cannot redact a line already recorded — so the pass belongs where the entries are
 * read, which is also the one place every driver shares.
 *
 * Each returns the entry UNCHANGED when nothing matched, so a run with no secrets declared pays
 * one comparison per entry and allocates nothing.
 */
export const safeConsole = (
  lines: readonly ConsoleLine[],
  secrets: ScrapeSecrets | undefined,
): readonly ConsoleLine[] =>
  lines.map((line) => {
    const text = redactSecrets(line.text, secrets);
    return text === line.text ? line : { ...line, text };
  });

/** A password pasted into a query string is the case name-based redaction cannot see at all. */
export const safeNetwork = (
  entries: readonly NetworkEntry[],
  secrets: ScrapeSecrets | undefined,
): readonly NetworkEntry[] =>
  entries.map((entry) => {
    const url = redactSecrets(entry.url, secrets);
    return url === entry.url ? entry : { ...entry, url };
  });

/** The stack too: a framework that prints the argument it threw on puts the value in both. */
export const safePageErrors = (
  errors: readonly PageError[],
  secrets: ScrapeSecrets | undefined,
): readonly PageError[] =>
  errors.map((error) => {
    const message = redactSecrets(error.message, secrets);
    const stack = error.stack === undefined ? undefined : redactSecrets(error.stack, secrets);
    if (message === error.message && stack === error.stack) return error;
    return { ...error, message, ...(stack === undefined ? {} : { stack }) };
  });

/** Every `<input …>` tag, whole, so the rewrite below never has to reason about attribute order. */
const INPUT_TAG = /<input\b[^>]*>/gi;
/** `type=password`, quoted either way or bare. */
const PASSWORD_TYPE = /\btype\s*=\s*(?:"password"|'password'|password)(?=[\s/>])/i;
const VALUE_ATTR = /\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

/**
 * `<input type="password" value="hunter2">` -> `value=""`, whatever the value happened to be —
 * and whatever ORDER the site wrote the attributes in.
 *
 * One regex over the whole tag required `type` to precede `value`, so `<input value="hunter2"
 * type="password">` came through untouched. Attribute order is the site's choice, and
 * `saveFailureArtifact` writes `page.html()` to object storage on every failed run: a
 * server-rendered password on a reversed-attribute form was durably persisted. So: match the TAG
 * first, then rewrite `value` inside it.
 */
export function blankPasswordFields(html: string): string {
  return html.replaceAll(INPUT_TAG, (tag) =>
    PASSWORD_TYPE.test(tag) ? tag.replaceAll(VALUE_ATTR, 'value=""') : tag,
  );
}

/** Both passes, in the order that matters: value redaction first, then the structural blank. */
export const safeHtml = (html: string, secrets: ScrapeSecrets | undefined): string =>
  blankPasswordFields(redactSecrets(html, secrets));
