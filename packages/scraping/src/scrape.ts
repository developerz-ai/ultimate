// `scrape()` — a browser run, declared as a `job` and NOT as a ninth primitive. One row of
// `PRIMITIVE_FACTORIES` in `@ultimat3/core`, which is the derived list of every factory that
// ships; an ordinal written here would be wrong the moment the next one lands, and was.
//
// It is a job by every field of the definition, not by analogy: a scrape has an input schema, a
// tenant, a retry policy, a timeout, a concurrency cap, a queue, and — decisively — a REQUIRED
// idempotency key and `step.run` checkpoints. Logging into a bank twice because a worker was
// killed between the login and its checkpoint is not a hypothetical; three wrong attempts locks
// the account. So this file is a FACTORY over `job()`, and a scrape inherits `.enqueue()`, the
// worker's cancellation, the dead-letter path, `x jobs show` and its manifest row for free.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type {
  JobCompleted,
  JobConcurrency,
  JobFailed,
  JobHandle,
  JobTenant,
  ProgressFn,
  RetryPolicy,
  StepApi,
} from '@ultimat3/jobs';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { StorageDriver } from '@ultimat3/storage';
import type { ArtifactWriter } from './artifacts';
import type { PromptHandler, ScrapeAuth } from './auth';
import type { ScrapeClock } from './clock';
import type { ScrapeDriver } from './driver';
import { yieldHistoryMissing } from './error-throws';
import type { YieldExpectation, YieldHistory } from './expect';
import type { HostRule } from './hosts';
import type { ScrapeHttp } from './http';
import type { ScrapePage } from './page';
import type { Recovery } from './recover';
import type { ResourceType } from './rings';
import type { RobotsPolicy } from './robots';
import { runScrape } from './scrape-run';
import type { ScrapeSecrets } from './secrets';
import type { ScrapeUsage } from './usage';
import { takeFailedUsage } from './usage';

export interface ScrapeRunArgs<I> {
  readonly input: I;
  /** Driver-blind. The same body runs on a browser, on a recording and on a string of HTML. */
  readonly page: ScrapePage;
  /**
   * The same session, over HTTP. Drive the browser through login and navigation, then pull the
   * bulk off the site's own JSON endpoints: the cookies, headers, proxy, host allow list, rate
   * limit and cancellation are the page's, so the authenticated browser session simply continues.
   */
  readonly http: ScrapeHttp;
  /** The job's own step api: one `step.run` per page, so a kill resumes where it stopped. */
  readonly step: StepApi;
  readonly ctx: Ctx;
  /** Declared names, resolved in the worker. A value never enters the queue row. */
  readonly secrets: ScrapeSecrets;
  readonly artifact: ArtifactWriter;
  readonly attempt: number;
  /** The job's own: true when a failure of this attempt is not retried for want of attempts. */
  readonly finalAttempt: boolean;
  /** The job's own `progress(done, total, note?)` — what `x jobs show` and a dashboard read. */
  readonly progress: ProgressFn;
  readonly runId: string;
}

export interface ScrapeArtifacts {
  /** A thunk, read per write — `() => disk('artifacts')`: the app's disk exists only after boot. */
  readonly storage?: (() => StorageDriver) | undefined;
  /** Save the page's HTML when the run fails. On by default — it is the only forensic left. */
  readonly onFailure?: boolean | undefined;
  readonly prefix?: string | undefined;
}

export interface ScrapeDefinition<I, Row> {
  /** REQUIRED, exactly as a backfill's is: the name is a durable queue key, never an export name. */
  readonly name: string;
  readonly input: StandardSchemaV1<unknown, I>;
  /**
   * Every row, parsed. A scrape's output is somebody else's HTML, so "it came back" and "it came
   * back in the shape this app stores" are different questions and this is the second one.
   * A row the schema rejects is `X_SCRAPE_OUTPUT_INVALID`, never a silently stored partial.
   */
  readonly extract: StandardSchemaV1<unknown, Row>;
  /** REQUIRED by the type, like every job's. */
  readonly idempotencyKey: (input: I) => string;
  /** REQUIRED by the type, like every job's. */
  readonly tenant: JobTenant<I>;
  /**
   * REQUIRED, and the field this package is most opinionated about. A headless browser with no
   * host list is the widest SSRF surface an app can own. `['*']` is the explicit escape hatch —
   * spelled out, visible in review — and there is no way to omit the decision.
   */
  readonly allowHosts: readonly HostRule[];
  readonly block?: readonly ResourceType[] | undefined;
  /** Navigations per second. Defaults to `DEFAULT_NAVIGATION_RATE`; there is no unpaced mode. */
  readonly rate?: number | undefined;
  readonly robots?: RobotsPolicy | undefined;
  /** The silent-green alarm. See `expect.ts` — this is the most valuable field here. */
  readonly expect?: YieldExpectation | undefined;
  readonly history?: YieldHistory | undefined;
  readonly artifacts?: ScrapeArtifacts | undefined;
  /** NAMES, never values. */
  readonly secrets?: readonly string[] | undefined;
  readonly recover?: Recovery | undefined;
  /**
   * Session lifecycle: acquire, persist, reuse, validate, burn. Authenticated scraping is the
   * primary case, so this is declared rather than hand-rolled per app. See `auth.ts`.
   */
  readonly auth?: ScrapeAuth<I> | undefined;
  /**
   * Where an out-of-band code comes from, for a site that asks for one after the password. The
   * request carries the run's `input` and `runId`: what a handler ties the prompt to.
   */
  readonly prompt?: PromptHandler<I> | undefined;
  readonly driver?: ScrapeDriver | undefined;
  /**
   * The exit THIS run leaves through — a proxy URL, credentials included — RESOLVED IN THE WORKER,
   * under the job's tenant: `async ({ connectionId }) => (await repo.connectionById(connectionId))
   * ?.exit`. The input names the row; the row (a `.sealed()` column) holds the exit. An exit whose
   * credential is ALSO in the input rode the queue payload and sits in `x_jobs` in the clear, and
   * is refused before the browser opens (`X_SCRAPE_EGRESS_IN_PAYLOAD`).
   *
   * It reaches the driver as `SessionInit.proxy` and wins over the driver's own `proxy`; both legs
   * and the robots read dial it. `undefined` leaves the driver's exit in force. A driver that
   * cannot dial it refuses with `X_SCRAPE_EGRESS_UNSUPPORTED` rather than dialling another.
   */
  readonly egress?:
    | ((input: I, ctx: Ctx) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly retry?: RetryPolicy | undefined;
  /** Per attempt, whole-run. `'5m'` or ms. */
  readonly timeout?: string | number | undefined;
  /** Per browser operation. `'30s'` or ms. */
  readonly pageTimeout?: string | number | undefined;
  /** Kill the browser after this much silence from it. See `watchdog.ts`. */
  readonly watchdog?: { readonly idleMs?: number; readonly graceMs?: number } | undefined;
  /** The job's own field, unchanged: a number, or `{ key, limit, whenBusy }` for a cap per key. */
  readonly concurrency?: JobConcurrency<I> | undefined;
  readonly queue?: string | undefined;
  /**
   * Pins this definition's clock. Omit it: a run waits on the process's (`scrapeClock()`), which
   * is the system clock and what a test replaces with `setScrapeClock()`.
   */
  readonly clock?: ScrapeClock | undefined;
  run(args: ScrapeRunArgs<I>): Promise<readonly unknown[]>;
  /**
   * The job's own `onSettled`, with what a scrape adds: a `completed` run hands over its
   * `ScrapeReport` — rows, artifacts and `usage` — and a run that ended any other way carries the
   * `usage` of its last attempt (`undefined` for a `refused` one, whose body never ran). Same
   * guarantees as the job's: after the row is settled, under the job's tenant, AT MOST ONCE
   * across a crash, and a hook that throws changes nothing.
   */
  onSettled?(settled: ScrapeSettled<I, Row>): Promise<void>;
}

/** How one scrape run ended, as `ScrapeDefinition.onSettled` is told. */
export type ScrapeSettled<I, Row> =
  | JobCompleted<I, ScrapeReport<Row>>
  | (JobFailed<I> & {
      /** What the last attempt used. A failed run has no report and was billed all the same. */
      readonly usage: ScrapeUsage | undefined;
    });

/** What one completed scrape reports — bounded, so `x jobs show` can print it. */
export interface ScrapeReport<Row> {
  readonly scrape: string;
  readonly rows: readonly Row[];
  readonly artifacts: readonly string[];
  /**
   * Requests interception refused, by reason. A zero-row run usually explains itself here — and it
   * is a FLOOR, not a total, whenever `networkDropped` is non-zero.
   */
  readonly refused: number;
  /**
   * Entries the bounded network ring dropped to stay bounded (`rings.ts`). Non-zero is the honest
   * "you are not seeing it all": `refused` was counted from what survived the bound.
   */
  readonly networkDropped: number;
  /** What this run used. A measurement: no quota is read from it and none is enforced. */
  readonly usage: ScrapeUsage;
}

export function scrape<I, Row>(definition: ScrapeDefinition<I, Row>): JobHandle<I> {
  // Refused where it is written, in the voice `backfill()` uses: a scrape with an empty host list
  // can never navigate anywhere, and finding that out is otherwise a dead-lettered job.
  assert(
    definition.allowHosts.length > 0,
    `scrape "${definition.name}" declares allowHosts: [] — nothing can be navigated to`,
    `list the hosts on scrape("${definition.name}") — allowHosts: ['example.com'] — or state the decision with allowHosts: ['*']`,
  );
  assert(
    definition.rate === undefined || (Number.isFinite(definition.rate) && definition.rate > 0),
    `scrape "${definition.name}" declares rate: ${String(definition.rate)} — a rate is navigations per second, greater than zero`,
    `set rate: 1 on scrape("${definition.name}"), or leave it out — to go faster raise the number, there is no unpaced mode`,
  );
  // Two halves that must be set together. `maxDrop` is a fraction of a trailing median and only
  // `history:` can supply one, so declaring it alone is an alarm that cannot fire — refused here,
  // where it is written, rather than discovered as a scrape that never once went red.
  if (definition.expect?.maxDrop !== undefined && definition.history === undefined) {
    throw yieldHistoryMissing(definition.name);
  }
  const onSettled = definition.onSettled?.bind(definition);
  return job<I, ScrapeReport<Row>>({
    name: definition.name,
    input: definition.input,
    idempotencyKey: definition.idempotencyKey,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    ...(definition.concurrency === undefined ? {} : { concurrency: definition.concurrency }),
    run: (args) => runScrape(definition, args),
    ...(onSettled === undefined
      ? {}
      : {
          onSettled: (settled) => {
            // Read on EVERY ending, the completed one too: a run that failed an attempt and then
            // completed must not leave that attempt's counts behind in this process.
            const usage = takeFailedUsage(settled.runId);
            return onSettled(settled.outcome === 'completed' ? settled : { ...settled, usage });
          },
        }),
  });
}
