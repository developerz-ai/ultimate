// Session lifecycle: acquire -> persist -> reuse -> validate -> burn. Authenticated scraping is
// the primary case, not an edge case, so this is a declared part of the API rather than something
// every app hand-rolls.
//
// The order below is the whole design, and each step is there because skipping it costs something
// real:
//
// | Step | Why it is not optional |
// |---|---|
// | reuse | logging in every run is slow, and the login itself is the anti-bot signal |
// | validate | an expired session must be caught by a cheap probe, not by a failure 40 steps later |
// | login | only when the probe says the session is gone — the author drives the browser |
// | persist | a 2FA code the user typed is worth keeping; that is the whole economic argument |
// | burn | a flagged identity stays flagged, so a retry on it re-trips the same block forever |
//
// What is NOT here, deliberately: credential stuffing, captcha solving, and any retry of a
// rejected credential. A rejected credential is `X_SCRAPE_AUTH_FAILED`, terminal, and the refusal
// is written into the session record so the NEXT attempt fails before reaching the login form.

import type { Logger } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { ScrapeClock } from './clock';
import { authFailed, promptUnanswered, sessionExpired } from './error-throws';
import type { ScrapePage } from './page';
import type { ScrapeSecrets } from './secrets';
import { type ScrapeSessionStore, type SessionState, sessionDigest } from './session-state';

export interface PromptRequest {
  /** What the site is asking for: `'sms code'`, `'authenticator code'`, `'security question 3'`. */
  readonly label: string;
  readonly scrape: string;
  readonly url: string;
}

/**
 * Where an out-of-band code comes from. A declared callback field on the definition — typed,
 * discoverable, one per concern — and never a global "register a plugin" call.
 */
export type PromptHandler = (request: PromptRequest) => Promise<string> | string;

export interface AuthContext<I> {
  readonly input: I;
  readonly page: ScrapePage;
  /**
   * The declared secrets, boxed. A login body needs the credential it is about to type, and
   * without this field there was no way to reach one — the README's own first example could not
   * have compiled, which is how the omission was found.
   */
  readonly secrets: ScrapeSecrets;
  /** The out-of-band code seam. Throws `X_SCRAPE_PROMPT_UNANSWERED` if nothing was declared. */
  prompt(label: string): Promise<string>;
}

export interface ScrapeAuth<I> {
  /**
   * Drives the browser through the login. Runs ONLY when there is no valid session — never on
   * every run, and never as a retry of a refused credential.
   */
  login(context: AuthContext<I>): Promise<void>;
  /**
   * The cheap probe: is the restored session still good? Site knowledge, so the author declares
   * it and the framework decides what to do with the answer. Omitted means a restored session is
   * trusted until something else fails.
   */
  validate?(context: AuthContext<I>): Promise<boolean>;
  /** Where sessions live. Omitted means no reuse at all — every run logs in. */
  readonly store?: ScrapeSessionStore | undefined;
  /**
   * The DISCRIMINATOR inside this tenant's key space — a second account, say. It is one segment of
   * `sessionKeyFor({ scrape, tenant, discriminator })` and never the whole key: a value that
   * replaced the key would put two tenants declaring the same account name on one authenticated
   * session. Sanitised like every other segment, so it cannot escape the key space either.
   */
  key?(input: I): string;
  /** Reuse a stored session. `false` forces a fresh login every run. Defaults to `true`. */
  readonly reuse?: boolean | undefined;
  /** Milliseconds. A stored session older than this is not restored. */
  readonly maxAge?: number | undefined;
}

export function createPrompt(
  scrape: string,
  handler: PromptHandler | undefined,
  page: ScrapePage,
): (label: string) => Promise<string> {
  return async (label: string): Promise<string> => {
    if (handler === undefined) throw promptUnanswered(scrape, label);
    const answer = await handler({ label, scrape, url: page.url() });
    if (typeof answer !== 'string' || answer === '') throw promptUnanswered(scrape, label);
    return answer;
  };
}

export interface AuthPlanInput<I> {
  readonly scrape: string;
  readonly auth: ScrapeAuth<I> | undefined;
  readonly key: string;
  readonly clock: ScrapeClock;
  readonly logger: Logger;
}

/**
 * The stored session this run may restore, or `undefined`.
 *
 * THROWS when the record carries a refusal: those credentials were rejected, and reaching the
 * login form again with them is how an account gets locked. It runs BEFORE `driver.open()`, which
 * is what it buys: `X_SCRAPE_AUTH_FAILED` is registered `terminal` so the queue will not retry,
 * and this makes a replay, a manual requeue or a second enqueue refuse without spending a browser,
 * a CDP attach or a request on an answer that cannot change.
 */
export async function restorableSession<I>(
  plan: AuthPlanInput<I>,
): Promise<SessionState | undefined> {
  const store = plan.auth?.store;
  if (store === undefined) return undefined;
  const found = await store.load(plan.key);
  if (found === undefined) return undefined;
  // The tombstone is read BEFORE `reuse` is honoured. `reuse: false` says "do not restore this
  // session"; it does not say "present the rejected credential again", and reading it first meant
  // a `reuse: false` scrape walked a refused password back to the login form on every requeue.
  if (found.refusedAt !== undefined) throw authFailed(plan.scrape, `refused at ${found.refusedAt}`);
  if (plan.auth?.reuse === false) return undefined;
  const maxAge = plan.auth?.maxAge;
  if (maxAge !== undefined) {
    // Screened, because `age > NaN` is false and false here means RESTORED: a `NaN` maxAge hands
    // back a session of any age, with no re-login and nothing in the report. `0` is legal — it
    // means "restore nothing stored before now" — so the floor stays there.
    const limit = finiteCount('the scrape auth', 'maxAge', maxAge);
    const age = plan.clock.now().getTime() - new Date(found.savedAt).getTime();
    // `!(age <= limit)` and not `age > limit`, which is the same test for every finite age and the
    // OPPOSITE one for a `NaN`. `savedAt` is data, not configuration: it comes back off a bucket
    // and `parseSessionState` only asks that it is a string, so an edited or half-written record
    // produces a `NaN` age against a perfectly good `maxAge`. Failing closed costs one re-login;
    // failing open acts as somebody else, indefinitely.
    if (!(age <= limit)) return undefined;
  }
  plan.logger.debug('scrape.session.restored', sessionDigest(found));
  return found;
}

/** Written down so the next attempt cannot reach the login form with the same credentials. */
export async function markRefused<I>(plan: AuthPlanInput<I>): Promise<void> {
  const store = plan.auth?.store;
  if (store === undefined) return;
  await store.save({
    key: plan.key,
    savedAt: plan.clock.now().toISOString(),
    refusedAt: plan.clock.now().toISOString(),
    cookies: [],
    headers: {},
    storage: {},
    userAgent: '',
    origin: '',
  });
}

/** New identity, from scratch. One call, because a flagged profile is unusable and must go. */
export async function burnSession<I>(plan: AuthPlanInput<I>): Promise<void> {
  if (plan.auth?.store === undefined) return;
  await plan.auth.store.burn(plan.key);
  plan.logger.warn('scrape.session.burned', { burned: true });
}

export interface EnsureAuthInput<I> extends AuthPlanInput<I> {
  readonly input: I;
  readonly page: ScrapePage;
  readonly secrets: ScrapeSecrets;
  readonly restored: SessionState | undefined;
  readonly prompt: (label: string) => Promise<string>;
}

/**
 * Log in if — and only if — this run has no session it can prove is still good.
 *
 * A resumed attempt takes the same path and reaches the same conclusion: the session lives in the
 * store, not in a step record, so restarting the job re-reads it and re-probes it rather than
 * replaying a checkpoint that says "logged in" about a session that has since expired. What a
 * step may persist is a cursor; a session is neither a cursor nor a page.
 */
export async function ensureAuthenticated<I>(args: EnsureAuthInput<I>): Promise<boolean> {
  const auth = args.auth;
  if (auth === undefined) return false;
  const context: AuthContext<I> = {
    input: args.input,
    page: args.page,
    secrets: args.secrets,
    prompt: args.prompt,
  };
  if (args.restored !== undefined) {
    if (auth.validate === undefined) return false;
    if (await auth.validate(context)) {
      args.logger.info('scrape.session.reused', { reused: true });
      return false;
    }
    args.logger.info('scrape.session.expired', { reused: false });
    await burnSession(args);
  }
  if (auth.login === undefined) throw sessionExpired(args.scrape, args.key);
  await auth.login(context);
  return true;
}

/** After a login: keep what it produced. A 2FA code somebody typed is worth exactly this. */
export async function persistSession<I>(plan: AuthPlanInput<I>, page: ScrapePage): Promise<void> {
  const store = plan.auth?.store;
  if (store === undefined) return;
  const snapshot = await page.session();
  await store.save({ ...snapshot, key: plan.key, savedAt: plan.clock.now().toISOString() });
  plan.logger.info('scrape.session.saved', sessionDigest(snapshot));
}
