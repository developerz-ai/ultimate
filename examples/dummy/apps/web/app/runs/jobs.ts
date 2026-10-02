/**
 * One sync of one connection: sign in, wait for the code a person types into the console, read
 * the accounts. `scrape()` is a job FACTORY, so this is a `job` — queue, retry, cancellation and
 * its manifest row included — and nothing here is a ninth kind of thing.
 *
 * Every phase appends one `run_events` row, keyed by the JOB's run id — the id `startRun` answered
 * and the console subscribes under. `seq` is allocated by `repo.appendEvent`, from 1. The phases a
 * body cannot write — a login that failed, a prompt nobody answered, a run its busy connection
 * refused — are written by `onSettled`, which is told how every run ended, and so is what the
 * run used: `ScrapeReport.usage` on completion, the last attempt's on a failure.
 *
 * The site is a RECORDING (`./fixtures`): this app has no browser to rent, so the driver replays
 * one directory for both legs — the browser login and the HTTP read.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package for it.
 */

import type { RunUsage } from '@postly/db';
import { type Infer, t } from '@ultimat3/jobs';
import type { PromptRequest, ScrapeUsage } from '@ultimat3/scraping';
import { eventPrompt, fixtureBrowser, scrape, storageSessionStore } from '@ultimat3/scraping';
import { disk } from '@ultimat3/storage';
import { ConnectionNotFound } from './errors';
import * as repo from './repo';

const SITE = 'ledger.example';
const LOGIN = `https://${SITE}/login`;
const ACCOUNTS = `https://${SITE}/accounts`;
const ACCOUNTS_API = `https://${SITE}/api/accounts`;

/** How long the site's question waits for a person. Past it the run fails; nothing retries it. */
export const PROMPT_TIMEOUT_MS = 300_000;
/** How often the run looks for the answer: one indexed read and one browser round trip each. */
export const PROMPT_POLL_MS = 250;
/** What the site asks for after the password. The console shows its own translated wording. */
export const PROMPT_LABEL = 'one-time code';
/** What a failure with no `X_*` code of its own is recorded as. */
const UNCLASSIFIED = 'X_INTERNAL';

const Account = t.object({ id: t.string, name: t.string });
const AccountPage = t.object({ rows: t.array(Account) });

/** What a run is queued with: ids only. The credential and the exit stay on the connection row. */
const SyncInput = t.object({
  connectionId: t.uuid,
  orgId: t.uuid,
  /** One per `startRun` call: two starts on one connection are two runs, never one deduped. */
  requestId: t.uuid,
});
type SyncInput = Infer<typeof SyncInput>;

/** The counts the run's `usage` event holds — `RunUsage`, which names no rented-browser cost. */
export const recordedUsage = (usage: ScrapeUsage): RunUsage => ({
  browserMs: Math.round(usage.browserMs),
  navigations: usage.navigations,
  httpRequests: usage.httpRequests,
  bytesIn: usage.bytesIn,
  promptsAnswered: usage.promptsAnswered,
});

const waitForAnswer = eventPrompt({ timeout: PROMPT_TIMEOUT_MS, pollMs: PROMPT_POLL_MS });

/** Say the run is waiting, wait with the browser open, say it resumed. */
export async function askConsole(request: PromptRequest<SyncInput>): Promise<string> {
  const event = { orgId: request.input.orgId, runId: request.runId, message: request.label };
  await repo.appendEvent({ ...event, kind: 'prompt', prompt: request.index });
  const answer = await waitForAnswer(request);
  await repo.appendEvent({ ...event, kind: 'answered' });
  return answer;
}

export const syncConnection = scrape({
  name: 'runs.sync',
  input: SyncInput,
  extract: Account,
  idempotencyKey: ({ requestId }) => `runs.sync:${requestId}`,
  tenant: ({ orgId }) => orgId,
  allowHosts: [SITE],
  driver: fixtureBrowser(`${import.meta.dir}/fixtures`),
  robots: { ignore: 'a recorded site: there is no origin to ask' },
  // A recording has no origin to be polite to; the default one navigation a second is for a site.
  rate: 20,
  // A session a person attends is not retried blind: a second attempt would ask them again.
  retry: { attempts: 1 },
  timeout: '10m',
  // Looked up in the worker, by id: a proxy URL carries its account, and the queue row must not.
  egress: async ({ connectionId }) => (await repo.connectionById(connectionId))?.exit ?? undefined,
  // One session per connection: a second run of the same one settles `failed`, X_JOB_KEY_BUSY.
  concurrency: { key: ({ connectionId }) => connectionId, limit: 1, whenBusy: 'fail' },
  auth: {
    // Declaring a store IS what persists the session — sealed under the app's master key.
    store: storageSessionStore(() => disk()),
    key: ({ connectionId }) => connectionId,
    login: async ({ page, prompt, secrets, input }) => {
      const connection = await repo.connectionById(input.connectionId);
      // Gone between the enqueue and the run: nothing to sign in with, and nothing to retry.
      if (connection === null) throw new ConnectionNotFound(input.connectionId);
      // Typed into the page, so it is redacted from everything the run could write down.
      secrets.conceal(connection.credential);
      await page.goto(LOGIN);
      await page.fill('#user', connection.label);
      await page.fill('#pass', connection.credential);
      await page.fill('#otp', await prompt(PROMPT_LABEL));
    },
  },
  prompt: askConsole,
  async run({ input, page, http, runId }) {
    const run = { orgId: input.orgId, runId };
    await page.goto(ACCOUNTS);
    await repo.appendEvent({ ...run, kind: 'navigated', message: ACCOUNTS });
    const batch = await (await http.request(ACCOUNTS_API)).parse(AccountPage);
    const read = String(batch.rows.length);
    await repo.appendEvent({ ...run, kind: 'extracted', message: read });
    await repo.appendEvent({ ...run, kind: 'done', message: read });
    return batch.rows;
  },
  /**
   * How the run ended. A run that did not complete — dead-lettered, or refused because its
   * connection was busy — becomes its `failed` event: the `X_*` code, never a message. Then what
   * the run used, completed or not, as its `usage` event; a refused run used nothing.
   */
  async onSettled(settled) {
    // A payload that no longer parses names no org to write the events under.
    if (settled.input === undefined) return;
    const run = { orgId: settled.input.orgId, runId: settled.runId };
    if (settled.outcome !== 'completed') {
      await repo.appendEvent({ ...run, kind: 'failed', message: settled.code ?? UNCLASSIFIED });
    }
    const usage = settled.outcome === 'completed' ? settled.result.usage : settled.usage;
    if (usage === undefined) return;
    await repo.appendEvent({ ...run, kind: 'usage', message: '', usage: recordedUsage(usage) });
  },
});
