// One session per connection, and a prompt answered from another process — against the pg driver
// and the stored event bus on a real Postgres. The unit suites prove the logic on the memory
// bus; this proves the two statements a service depends on: the keyed lease that refuses a second
// run of one connection, and `x_job_events` carrying a sealed answer between two processes while
// the first run keeps its claim. Opt-in (`.job.`): it needs a server two processes can reach.
//
// Skips unless `TEST_DATABASE_URL` is set:
//
//   docker compose -f docker/docker-compose.test.yml up -d --wait postgres
//   set -a; . docker/test-services.env; set +a
//   bun test packages/scraping/src/session.job.test.ts

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isSealed, structuredLogger } from '@ultimat3/core';
import type { JobDriver, JobRecord, PgExecutor, Worker } from '@ultimat3/jobs';
import {
  jobWorker,
  postgresEventBus,
  postgresJobDriver,
  resetJobs,
  SQL_JOBS_TABLE,
} from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { memoryStorageDriver } from '@ultimat3/storage';
import type { PromptRequest } from './auth';
import type { ScrapeClock } from './clock';
import { systemScrapeClock } from './clock';
import type { ScrapeDriver } from './driver';
import { fakeBrowser } from './driver-fake';
import { eventPrompt } from './event-prompt';
import { scrape } from './scrape';
import { storageSessionStore } from './session-state';

const url = Bun.env['TEST_DATABASE_URL'];
const describeJob = url === undefined ? describe.skip : describe;

/** Its own database: this file applies the queue's tables and drops them with it. */
const PROBE_DB = 'x_scrape_session_probe';
const MASTER_KEY = 'e5'.repeat(32);
const KEYS = { env: { ULTIMATE_SECRETS_KEY: MASTER_KEY }, root: '/nonexistent-app-root' };
const LOGIN = 'https://bank.test/login';
const ANSWER = '482913';

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const admin = async (statement: string): Promise<void> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

/**
 * The REAL clock, read past the test preload's frozen `Date`: the answering process is a plain
 * `bun` with no preload, and "published after the prompt was asked" compares the two.
 */
const realClock: ScrapeClock = {
  now: () => new Date(performance.timeOrigin + performance.now()),
  monotonic: () => performance.now(),
  sleep: (ms, signal) => systemScrapeClock.sleep(ms, signal),
};

interface Input {
  readonly connectionId: string;
  readonly requestId: string;
}

/**
 * `Bun.SQL` binds a JS array as a comma-joined string, which Postgres refuses as an array
 * (`22P02`). `@ultimat3/db`'s client owns the real conversion; this package does not depend on it,
 * and the queue binds exactly one array — queue NAMES — so the literal is written here.
 */
const bound = (value: unknown): unknown =>
  Array.isArray(value)
    ? `{${value.map((entry) => JSON.stringify(String(entry))).join(',')}}`
    : value;

let sql: InstanceType<typeof Bun.SQL> | undefined;
let executor: PgExecutor | undefined;

beforeAll(async () => {
  if (url === undefined) return;
  await admin(`drop database if exists ${PROBE_DB} with (force)`);
  await admin(`create database ${PROBE_DB}`);
  const client = new Bun.SQL(probeUrl(), { max: 4, prepare: false });
  sql = client;
  executor = {
    query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      [...(await client.unsafe(text, values.map(bound)))] as R[],
  };
  for (const statement of SQL_JOBS_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.unsafe(statement, []);
  }
}, 60_000);

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

const workerOn = (driver: JobDriver, workerId: string): Worker =>
  jobWorker({
    driver,
    workerId,
    concurrency: 1,
    visibilityTimeoutMs: 30_000,
    // Short, so "the run kept its claim while it waited" is observable inside the test.
    heartbeatIntervalMs: 100,
    pollIntervalMs: 0,
    context: () =>
      ctxOf({
        role: 'worker',
        buildId: 'test',
        logger: structuredLogger({ writer: () => undefined }),
      }),
    drainOnShutdown: false,
  });

const rowOf = async (driver: JobDriver, id: string): Promise<JobRecord> => {
  const row = await driver.introspect?.job(id);
  if (row === undefined) return expect.unreachable(`no job ${id} in the ${driver.name} driver`);
  return row;
};

/** The answering side, as its own OS process: nothing in common with the worker but Postgres. */
const answerFromAnotherProcess = async (runId: string): Promise<number> => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import { postgresEventBus } from '@ultimat3/jobs';
       import { answerPrompt } from './event-prompt';
       const sql = new Bun.SQL(process.env.PROBE_URL, { max: 1, prepare: false });
       const bus = postgresEventBus({
         executor: { query: async (text, values) => [...(await sql.unsafe(text, [...values]))] },
       });
       await answerPrompt({ runId: process.env.RUN_ID, index: 1, answer: process.env.ANSWER, bus });
       await sql.end();`,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...Bun.env,
        PROBE_URL: probeUrl(),
        RUN_ID: runId,
        ANSWER,
        // The app's master key, found where `seal()` finds it in a real process: the environment.
        ULTIMATE_SECRETS_KEY: MASTER_KEY,
      },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  return child.exited;
};

describeJob('job · a scrape session on the pg driver and the stored event bus', () => {
  test('one run per connection: the second is refused; the first is answered from another process', async () => {
    if (executor === undefined) return expect.unreachable('the probe database was not opened');
    const driver = postgresJobDriver({ executor });
    const bus = postgresEventBus({ executor });
    const storage = memoryStorageDriver();
    const waitForAnswer = eventPrompt({ timeout: 30_000, pollMs: 50, bus, keySource: KEYS });

    let opens = 0;
    const inner = fakeBrowser([
      { url: LOGIN, html: '<form><input id="otp"></form><p class="row" data-id="acct-1">One</p>' },
    ]);
    const counting: ScrapeDriver = {
      name: inner.name,
      open: (init) => {
        opens += 1;
        return inner.open(init);
      },
    };
    let announce: (request: PromptRequest) => void = () => undefined;
    const asked = new Promise<PromptRequest>((resolve) => {
      announce = resolve;
    });
    const answers: string[] = [];

    const handle = scrape<Input, { id: string }>({
      name: 'scrape-session-probe',
      input: t.object({ connectionId: t.string, requestId: t.string }),
      extract: t.object({ id: t.string }),
      idempotencyKey: ({ requestId }) => `session:${requestId}`,
      tenant: 'none',
      allowHosts: ['bank.test'],
      robots: { ignore: 'a recorded site: there is no origin to ask' },
      clock: realClock,
      driver: counting,
      retry: { attempts: 1, jitter: false },
      concurrency: { key: ({ connectionId }) => connectionId, limit: 1, whenBusy: 'fail' },
      auth: {
        store: storageSessionStore(() => storage, { keySource: KEYS }),
        key: ({ connectionId }) => connectionId,
        login: async ({ page, prompt }) => {
          await page.goto(LOGIN);
          const answer = await prompt('sms code');
          answers.push(answer);
          await page.fill('#otp', answer);
        },
      },
      // The app's own wrapper: say a prompt is pending, then wait for its answer on the bus.
      prompt: (request) => {
        announce(request);
        return waitForAnswer(request);
      },
      async run({ page }) {
        return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
      },
    });

    const enqueue = async (requestId: string): Promise<string> =>
      (
        await driver.enqueue({
          name: handle.name,
          queue: 'default',
          input: { connectionId: 'conn-1', requestId },
          idempotencyKey: `session:${requestId}`,
          maxAttempts: handle.retry.attempts,
        })
      ).id;
    const first = await enqueue('req-1');
    const second = await enqueue('req-2');
    const a = workerOn(driver, 'worker-a');
    const b = workerOn(driver, 'worker-b');

    // Worker A takes the first run, opens the browser, reaches the login and asks.
    const holding = a.tick();
    // Raced against the pass itself: a run that ended WITHOUT asking would otherwise be a hang
    // until the test's own timeout, with nothing saying which await never settled.
    const request = await Promise.race([
      asked,
      holding.then(async () =>
        expect.unreachable(
          `the first run settled before asking: ${String((await rowOf(driver, first)).lastError)}`,
        ),
      ),
    ]);
    expect(request.index).toBe(1);
    expect(request.runId).toBe((await rowOf(driver, first)).runId);

    // Worker B takes the second run of the SAME connection while A holds it: refused, body unrun.
    await b.tick();
    const refused = await rowOf(driver, second);
    expect(refused.state).toBe('failed');
    expect(refused.lastError).toContain('X_JOB_KEY_BUSY');
    expect(opens).toBe(1);

    // The first run is still running and still renewing its claim — it polls in process, it did
    // not suspend. The lease moves forward while the run waits.
    const claimed = await rowOf(driver, first);
    expect(claimed.state).toBe('running');
    let renewed = claimed;
    for (
      let look = 0;
      look < 100 && (renewed.visibleAt ?? 0) <= (claimed.visibleAt ?? 0);
      look += 1
    ) {
      await realClock.sleep(50);
      renewed = await rowOf(driver, first);
    }
    expect(renewed.visibleAt ?? 0).toBeGreaterThan(claimed.visibleAt ?? 0);
    expect(renewed.state).toBe('running');

    // The answer, from another process, through `x_job_events`.
    expect(await answerFromAnotherProcess(request.runId)).toBe(0);
    await holding;

    expect(answers).toEqual([ANSWER]);
    expect((await rowOf(driver, first)).state).toBe('done');
    // What crossed the database is sealed: the event row never held the code.
    const events = await bus.list(`scrape-prompt:${request.runId}:1`);
    expect(events).toHaveLength(1);
    expect(isSealed(events[0]?.payload)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(ANSWER);
    // And the session that login produced is stored sealed.
    expect(storage.objects().size).toBe(1);
    const stored = [...storage.objects().values()]
      .map((bytes) => new TextDecoder().decode(bytes))
      .join('');
    expect(stored).toContain('"sealed":"x1.');
  }, 60_000);
});
