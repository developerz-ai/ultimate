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
import { systemScrapeClock } from './clock';
import type { ScrapeSession } from './driver';
import { scrapeDriver } from './driver';
import { driverUnknown, outputInvalid } from './error-throws';
import { scrapeLogger, withStepEvent } from './events';
import { guardYield } from './expect';
import { burnsSession, errorCode, neverRetried } from './failures';
import { createPacer, DEFAULT_NAVIGATION_RATE } from './rate';
import { runRecovery } from './recover';
import { createRobotsGate } from './robots';
import type { ScrapeDefinition, ScrapeReport } from './scrape';
import { createSecretBag } from './secrets';
import { sessionKeyFor } from './session-state';

/** `ctx.actor` is a structural read: this package never imports the auth types (tier 2). */
const orgOf = (ctx: unknown): string | undefined => {
  const actor = (ctx as { actor?: { orgId?: unknown } }).actor;
  return typeof actor?.orgId === 'string' ? actor.orgId : undefined;
};

const toMillis = (value: string | number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (match === null) return fallback;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms'] ?? 1;
  return Number(match[1]) * scale;
};

export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

export async function runScrape<I, Row>(
  definition: ScrapeDefinition<I, Row>,
  args: JobRunArgs<I>,
): Promise<ScrapeReport<Row>> {
  const clock = definition.clock ?? systemScrapeClock;
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
  const rules = { allowHosts: definition.allowHosts, block: definition.block };
  const pace = createPacer(definition.rate ?? DEFAULT_NAVIGATION_RATE, clock);
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
  const pageTimeoutMs = toMillis(definition.pageTimeout, DEFAULT_PAGE_TIMEOUT_MS);
  const session = await driver.open({
    name: definition.name,
    rules,
    clock,
    timeoutMs: pageTimeoutMs,
    secrets,
    // The gate reads `/robots.txt` over the network, so it gets the run's deadline and the run's
    // cancellation like every other call this package makes. Without them a hung origin parks
    // every later navigation to it on one cached promise, unreachable by `ctx.signal`.
    robots: createRobotsGate({
      policy: definition.robots ?? 'obey',
      timeoutMs: pageTimeoutMs,
      signal: args.ctx.signal,
    }),
    signal: args.ctx.signal,
    restore: restored,
    pace: (signal) => pace(signal),
    watchdog: definition.watchdog,
  });

  try {
    if (definition.auth !== undefined) {
      const loggedIn = await withStepEvent(
        { name: 'auth', logger, clock, attempt: args.attempt },
        () =>
          ensureAuthenticated({
            ...plan,
            input: args.input,
            page: session.page,
            secrets,
            restored,
            prompt: createPrompt(definition.name, definition.prompt, session.page),
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
    logger.info('scrape.ok', { rows: rows.length, refused });
    return {
      scrape: definition.name,
      rows,
      artifacts: artifact.saved.map((ref) => ref.key),
      refused,
      networkDropped,
    };
  } catch (thrown) {
    logger.error('scrape.failed', { code: errorCode(thrown) });
    if (errorCode(thrown) === 'X_SCRAPE_AUTH_FAILED') await markRefused(plan);
    else if (burnsSession(thrown)) await burnSession(plan);
    if (definition.artifacts?.onFailure !== false) await saveFailureArtifact(session, artifact);
    throw thrown;
  } finally {
    // Always, and it never throws: `close()` ends the local connection AND the remote browser.
    await session.close();
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
      runId: args.runId,
    });
  try {
    return await withStepEvent(
      { name: 'body', logger, clock: definition.clock ?? systemScrapeClock, attempt: args.attempt },
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
