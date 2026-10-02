// One attempt, assembled: driver, secrets, robots gate, pacing, session lifecycle, the body, the
// extract schema, the yield alarm, the artifacts, the teardown.
//
// RESTARTABILITY, stated once because it is the property everything here is arranged around: a
// killed attempt resumes from the caller's own `step.run` checkpoints, and what a step may persist
// is a CURSOR — a page number, an id, an offset. Never a page, never a live handle, never a
// session. The session lives in the session store and is re-probed on every attempt, which is what
// makes a resumed run skip the login when the session is still good and re-login when it is not.
// A step record saying "logged in" would be a checkpoint asserting something about a session that
// may have expired an hour ago.

import { finiteCount, finiteOption } from '@ultimat3/core';
import type { JobRunArgs } from '@ultimat3/jobs';
import { parse } from '@ultimat3/schema';
import { createArtifactWriter } from './artifacts';
import type { AuthPlanInput } from './auth';
import {
  burnSession,
  createPrompt,
  ensureAuthenticated,
  markRefused,
  persistSession,
  restorableSession,
} from './auth';
import { scrapeClock } from './clock';
import type { ScrapeSession } from './driver';
import { scrapeDriver } from './driver';
import { driverUnknown, outputInvalid } from './error-throws';
import { egressInPayload } from './error-throws-session';
import type { ScrapeEventFields } from './events';
import { scrapeLogger, withStepEvent } from './events';
import { guardYield } from './expect';
import { burnsSession, errorCode, neverRetried } from './failures';
import { createPacer, DEFAULT_NAVIGATION_RATE } from './rate';
import { runRecovery } from './recover';
import { createRobotsGate } from './robots';
import type { ScrapeDefinition, ScrapeReport } from './scrape';
import { containsSecret } from './secret-scan';
import { createSecretBag, MIN_REDACTABLE_LENGTH } from './secrets';
import { sessionKeyFor } from './session-state';
import { hasCredentials, splitCredentials, urlSecretValues } from './url-secrets';
import type { ScrapeUsage } from './usage';
import { createUsageMeter, rememberFailedUsage } from './usage';

/** `ctx.actor` is a structural read: this package never imports the auth types (tier 2). */
const orgOf = (ctx: unknown): string | undefined => {
  const actor = (ctx as { actor?: { orgId?: unknown } }).actor;
  return typeof actor?.orgId === 'string' ? actor.orgId : undefined;
};

/**
 * `'30s'` | `30_000` | absent, as milliseconds — screened under the name the DEFINITION uses.
 *
 * The number branch is the one that needs it: the string branch can only ever produce digits, and
 * a number a definition declares is whatever the app computed. What it lands on is the reason the
 * refusal is here rather than downstream — this one value becomes the robots read's deadline
 * (where a non-finite one turns robots enforcement off silently, because every failure of that
 * read answers "no restrictions"), the session's `timeoutMs`, and through it every actionability
 * budget in the run, where `NaN <= 0` is false so the poll loop never leaves.
 */
const toMillis = (value: string | number | undefined, fallback: number, option: string): number => {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return finiteCount('the scrape definition', option, value, 1);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (match === null) return fallback;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms'] ?? 1;
  return finiteCount('the scrape definition', option, Number(match[1]) * scale, 1);
};

export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

/**
 * True when the exit's password is readable out of the run's own input — which is the queue row.
 * Both spellings, because a password with a quote or a backslash is stored JSON-escaped; and
 * nothing shorter than `MIN_REDACTABLE_LENGTH`, which is a substring of ordinary payload text.
 */
function credentialInPayload(egress: string, input: unknown): boolean {
  const { password } = splitCredentials(egress);
  if (password.length < MIN_REDACTABLE_LENGTH) return false;
  const payload = JSON.stringify(input ?? null);
  const escaped = JSON.stringify(password).slice(1, -1);
  // Both scans always run: an `||` would skip the second exactly when the first found the secret.
  const plain = containsSecret(payload, password);
  return containsSecret(payload, escaped) || plain;
}

export async function runScrape<I, Row>(
  definition: ScrapeDefinition<I, Row>,
  args: JobRunArgs<I>,
): Promise<ScrapeReport<Row>> {
  const clock = definition.clock ?? scrapeClock();
  const driver = definition.driver ?? scrapeDriver();
  // The scrape's name goes in the SCRAPE slot: there is no driver here to name, which is the
  // whole failure.
  if (driver === undefined) throw driverUnknown(undefined, [], definition.name);
  const logger = scrapeLogger(args.ctx.logger, {
    scrape: definition.name,
    runId: args.runId,
    attempt: args.attempt,
    driver: driver.name,
  });
  const secrets = createSecretBag(definition.secrets ?? []);
  // The run's exit, resolved HERE — in the worker, under the job's tenant — so what the queue row
  // carries is the id of whatever holds it. An empty answer is "none", the same as absent: a
  // driver handed `''` would dial `--proxy-server=` and call that a decision.
  const declared = await definition.egress?.(args.input, args.ctx);
  const egress = declared === undefined || declared === '' ? undefined : declared;
  if (egress !== undefined && hasCredentials(egress)) {
    // Concealed HERE and not only in the driver that dials it: an offline or third-party driver
    // never parses the exit, and the page artifact is redacted from this one bag either way.
    for (const value of urlSecretValues(egress)) secrets.conceal(value);
    // Before the browser opens: the credential is in `x_jobs` already, and running would only add
    // a session to an exposure somebody has to rotate.
    if (credentialInPayload(egress, args.input)) {
      throw egressInPayload({ scrape: definition.name, egress });
    }
  }
  const rules = { allowHosts: definition.allowHosts, block: definition.block };
  // Screened here as well as in `scrape()`, and the two are not one check written twice: that one
  // refuses the DECLARATION and never sees a definition assembled by hand, which `runScrape` is
  // exported to accept. `finiteOption` and not `finiteCount` — a rate of 0.5 is one navigation
  // every two seconds, and `scrape()` owns the "greater than zero" half.
  const pace = createPacer(
    finiteOption('the scrape definition', 'rate', definition.rate ?? DEFAULT_NAVIGATION_RATE),
    clock,
  );
  const artifact = createArtifactWriter({
    storage: definition.artifacts?.storage,
    scrape: definition.name,
    runId: args.runId,
    prefix: definition.artifacts?.prefix,
  });
  const plan: AuthPlanInput<I> = {
    scrape: definition.name,
    auth: definition.auth,
    // `auth.key` DISCRIMINATES inside the tenant's key space; it never replaces it. Letting it
    // replace the key gave two tenants declaring the same account name one authenticated session,
    // and skipped the sanitising `sessionKeyFor` does to a value that is also a storage path.
    key: sessionKeyFor({
      scrape: definition.name,
      tenant: orgOf(args.ctx),
      discriminator: definition.auth?.key?.(args.input),
    }),
    clock,
    logger,
  };

  // Read BEFORE the browser opens: a refused credential must not reach a login form again, and
  // opening a session first would already have spent an identity on a run that cannot succeed.
  const restored = await restorableSession(plan);
  const pageTimeoutMs = toMillis(definition.pageTimeout, DEFAULT_PAGE_TIMEOUT_MS, 'pageTimeout');
  // The exit the session dials, readable only AFTER `driver.open()` — a driver with no run exit
  // falls back to its own option, and the gate below is an argument to `open()`, so the gate asks
  // for it per read instead of being handed a value that cannot exist yet. Every read happens
  // during a navigation, which is after this is assigned.
  let sessionProxy: string | undefined;
  // Before `open()`: the time a rented browser takes to arrive is time it was held.
  const usage = createUsageMeter(clock);
  const session = await driver.open({
    name: definition.name,
    logger,
    runId: args.runId,
    ...(egress === undefined ? {} : { proxy: egress }),
    usage,
    rules,
    clock,
    timeoutMs: pageTimeoutMs,
    secrets,
    // The gate reads `/robots.txt` over the network, so it gets the run's deadline, the run's
    // cancellation and the run's exit, like every other call this package makes. Without the
    // first two a hung origin parks every later navigation to it on one cached promise,
    // unreachable by `ctx.signal`; without the third the read leaves from a different IP than
    // every page load, and an origin reachable only through the proxy answers nothing — which
    // this gate reads as "no restrictions".
    robots: createRobotsGate({
      policy: definition.robots ?? 'obey',
      timeoutMs: pageTimeoutMs,
      signal: args.ctx.signal,
      proxy: () => sessionProxy,
    }),
    signal: args.ctx.signal,
    restore: restored,
    pace: (signal) => pace(signal),
    watchdog: definition.watchdog,
  });
  sessionProxy = session.proxy;

  try {
    if (definition.auth !== undefined) {
      const loggedIn = await withStepEvent(
        { name: 'auth', logger, clock, attempt: args.attempt },
        () =>
          ensureAuthenticated({
            ...plan,
            input: args.input,
            runId: args.runId,
            page: session.page,
            secrets,
            restored,
            prompt: createPrompt({
              scrape: definition.name,
              handler: definition.prompt,
              input: args.input,
              page: session.page,
              runId: args.runId,
              clock,
              signal: args.ctx.signal,
              secrets,
              onAnswered: () => usage.promptAnswered(),
            }),
          }),
      );
      // Persisted after a LOGIN only, never after a reuse: rewriting the record on every run
      // refreshes `savedAt` without refreshing the session, so `maxAge` would never expire it.
      if (loggedIn) await persistSession(plan, session.page);
    }

    const raw = await bodyWithRecovery(definition, args, session, logger, artifact, secrets);
    const rows = raw.map((row): Row => {
      try {
        return parse(definition.extract, row);
      } catch (thrown) {
        throw outputInvalid(definition.name, errorCode(thrown) ?? 'the row did not parse');
      }
    });
    await guardYield({
      scrape: definition.name,
      rows: rows.length,
      expect: definition.expect,
      history: definition.history,
    });
    const refused = session.page.network().filter((entry) => entry.refused !== undefined).length;
    // The ring is bounded, so `refused` is a FLOOR and this is what says so. Reporting the count
    // alone made a run that blocked 5,000 images print 200 and discarded the one number
    // (`Ring.dropped`) that exists to say "you are not seeing it all".
    const networkDropped = session.page.networkDropped();
    const used = usage.snapshot(session.browserCost);
    logger.info('scrape.ok', { rows: rows.length, refused, ...usageFields(used) });
    return {
      scrape: definition.name,
      rows,
      artifacts: artifact.saved.map((ref) => ref.key),
      refused,
      networkDropped,
      usage: used,
    };
  } catch (thrown) {
    // A failed run has no report, and it was billed all the same: the counts ride the one line
    // every failure already writes.
    const used = usage.snapshot(session.browserCost);
    logger.error('scrape.failed', { code: errorCode(thrown), ...usageFields(used) });
    // Kept for `onSettled`, and only when somebody declared one to read it.
    if (definition.onSettled !== undefined) rememberFailedUsage(args.runId, used);
    if (errorCode(thrown) === 'X_SCRAPE_AUTH_FAILED') {
      await recordSessionOutcome('session.refuse', logger, () => markRefused(plan));
    } else if (burnsSession(thrown)) {
      await recordSessionOutcome('session.burn', logger, () => burnSession(plan));
    }
    if (definition.artifacts?.onFailure !== false) await saveFailureArtifact(session, artifact);
    throw thrown;
  } finally {
    // Always, and it never throws: `close()` ends the local connection AND the remote browser.
    await session.close();
  }
}

/** The counts as log fields. `browserCost` stays off the line: it is on the report, as `Money`. */
const usageFields = (used: ScrapeUsage): ScrapeEventFields => ({
  browserMs: used.browserMs,
  navigations: used.navigations,
  httpRequests: used.httpRequests,
  bytesIn: used.bytesIn,
  promptsAnswered: used.promptsAnswered,
});

/**
 * The tombstone or the burn, on the way out — best effort, and it may NEVER replace the failure
 * that caused it. `markRefused` reaches `store.save()` reaches `storage.put()`, so an S3 503 or an
 * `X_STORAGE_PATH_UNSAFE` from a tenant whose key sanitises to nothing used to propagate out of
 * the catch and REPLACE a terminal `X_SCRAPE_AUTH_FAILED` with a retryable one. Attempt 2 then
 * found no tombstone — the save is what failed — and walked the same rejected password back to
 * the login form; attempt 3 locks the account. Same rule as `saveFailureArtifact`, and the same
 * reason: the run's own error is the one the reader needs.
 */
async function recordSessionOutcome(
  step: 'session.refuse' | 'session.burn',
  logger: ReturnType<typeof scrapeLogger>,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (thrown) {
    // Logged rather than swallowed silently: the tombstone is missing, so the NEXT attempt will
    // re-probe rather than refuse cheaply, and that is a fact an operator has to be able to see.
    logger.error('scrape.session.write_failed', { step, code: errorCode(thrown) });
  }
}

/**
 * The body, with at most ONE recovery pass. `recover` never runs for a failure that must not be
 * retried — a rejected credential is the case, and asking a model to "fix" a wrong password is
 * how an account gets locked.
 */
async function bodyWithRecovery<I, Row>(
  definition: ScrapeDefinition<I, Row>,
  args: JobRunArgs<I>,
  session: ScrapeSession,
  logger: ReturnType<typeof scrapeLogger>,
  artifact: ReturnType<typeof createArtifactWriter>,
  secrets: ReturnType<typeof createSecretBag>,
): Promise<readonly unknown[]> {
  const body = (): Promise<readonly unknown[]> =>
    definition.run({
      input: args.input,
      page: session.page,
      http: session.http,
      step: args.step,
      ctx: args.ctx,
      secrets,
      artifact,
      attempt: args.attempt,
      finalAttempt: args.finalAttempt,
      progress: args.progress,
      runId: args.runId,
    });
  try {
    return await withStepEvent(
      { name: 'body', logger, clock: definition.clock ?? scrapeClock(), attempt: args.attempt },
      body,
    );
  } catch (thrown) {
    if (definition.recover === undefined || neverRetried(thrown)) throw thrown;
    const recovered = await runRecovery(definition.recover, {
      scrape: definition.name,
      page: session.page,
      failure: thrown,
      attempt: args.attempt,
    });
    if (!recovered) throw thrown;
    logger.warn('scrape.recovered', { code: errorCode(thrown) });
    return await body();
  }
}

/**
 * The page HTML, on failure — redacted by value, password fields blanked. It is the only forensic
 * left once the browser is gone, and by the time somebody looks the page has changed.
 */
async function saveFailureArtifact(
  session: ScrapeSession,
  artifact: ReturnType<typeof createArtifactWriter>,
): Promise<void> {
  try {
    await artifact.save('page.html', await session.page.html());
  } catch {
    // A failed artifact must never replace the failure that caused it. The run's own error is the
    // one the reader needs; this is a best effort on the way out.
  }
}
