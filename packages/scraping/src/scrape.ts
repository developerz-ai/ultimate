// `scrape()` — a browser run, declared as a `job` and NOT as a ninth primitive. The rule's fourth
// instance after `llm()` (an action factory) and `backfill()` (a job factory).
//
// It is a job by every field of the definition, not by analogy: a scrape has an input schema, a
// tenant, a retry policy, a timeout, a concurrency cap, a queue, and — decisively — a REQUIRED
// idempotency key and `step.run` checkpoints. Logging into a bank twice because a worker was
// killed between the login and its checkpoint is not a hypothetical; three wrong attempts locks
// the account. So this file is a FACTORY over `job()`, and a scrape inherits `.enqueue()`, the
// worker's cancellation, the dead-letter path, `x jobs show` and its manifest row for free.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { JobHandle, JobTenant, RetryPolicy, StepApi } from '@ultimat3/jobs';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { StorageDriver } from '@ultimat3/storage';
import type { ArtifactWriter } from './artifacts';
import type { PromptHandler, ScrapeAuth } from './auth';
import type { ScrapeClock } from './clock';
import type { ScrapeDriver } from './driver';
import type { YieldExpectation, YieldHistory } from './expect';
import type { HostRule } from './hosts';
import type { ScrapeHttp } from './http';
import type { ScrapePage } from './page';
import type { Recovery } from './recover';
import type { ResourceType } from './rings';
import type { RobotsPolicy } from './robots';
import { runScrape } from './scrape-run';
import type { ScrapeSecrets } from './secrets';

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
  readonly runId: string;
}

export interface ScrapeArtifacts {
  readonly storage?: StorageDriver | undefined;
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
  /** Where an out-of-band code comes from, for a site that asks for one after the password. */
  readonly prompt?: PromptHandler | undefined;
  readonly driver?: ScrapeDriver | undefined;
  readonly retry?: RetryPolicy | undefined;
  /** Per attempt, whole-run. `'5m'` or ms. */
  readonly timeout?: string | number | undefined;
  /** Per browser operation. `'30s'` or ms. */
  readonly pageTimeout?: string | number | undefined;
  /** Kill the browser after this much silence from it. See `watchdog.ts`. */
  readonly watchdog?: { readonly idleMs?: number; readonly graceMs?: number } | undefined;
  readonly concurrency?: number | undefined;
  readonly queue?: string | undefined;
  readonly clock?: ScrapeClock | undefined;
  run(args: ScrapeRunArgs<I>): Promise<readonly unknown[]>;
}

/** What one completed scrape reports — bounded, so `x jobs show` can print it. */
export interface ScrapeReport<Row> {
  readonly scrape: string;
  readonly rows: readonly Row[];
  readonly artifacts: readonly string[];
  /** Requests interception refused, by reason. A zero-row run usually explains itself here. */
  readonly refused: number;
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
  return job<I>({
    name: definition.name,
    input: definition.input,
    idempotencyKey: definition.idempotencyKey,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    ...(definition.concurrency === undefined ? {} : { concurrency: definition.concurrency }),
    run: (args) => runScrape(definition, args),
  });
}
