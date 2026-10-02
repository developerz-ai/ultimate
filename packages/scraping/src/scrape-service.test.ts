// What a SERVICE built on `scrape()` needs from one run, each proved through a real worker rather
// than a hand-driven body: the report reaches the app, a refusal and a login failure are told, the
// prompt knows which run it is for, the exit never rides the queue payload, the session disk is
// bound when it is used, and a test supplies the clock.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext } from '@ultimat3/core';
import type { JobDriver, JobHandle } from '@ultimat3/jobs';
import {
  createMemoryDriver,
  createMemoryEventBus,
  createWorker,
  resetEventBus,
  resetJobs,
  setEventBus,
} from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { defineStorage, disk, memoryDriver, resetStorage } from '@ultimat3/storage';
import type { PromptRequest } from './auth';
import { noWaitClock, resetScrapeClock, setScrapeClock } from './clock';
import type { ScrapeDriver, SessionInit } from './driver';
import { fakeBrowser } from './driver-fake';
import { answerPrompt, eventPrompt } from './event-prompt';
import type { ScrapeDefinition, ScrapeSettled } from './scrape';
import { scrape } from './scrape';
import { storageSessionStore } from './session-state';

const KEYS = { env: { ULTIMATE_SECRETS_KEY: 'd4'.repeat(32) }, root: '/nonexistent-app-root' };
const ORG = '00000000-0000-4000-8000-0000000000a1';
const LOGIN = 'https://bank.test/login';
const ACCOUNTS = 'https://bank.test/accounts';
const PAGES = [
  { url: LOGIN, html: '<form><input id="user"><input id="otp"></form>' },
  { url: ACCOUNTS, html: '<ul><li class="row" data-id="acct-1">One</li></ul>' },
];
/** A proxy URL with a credential in it: what an exit actually is. */
const EXIT = 'http://session-41:hunter2hunter2@exit-7.test:8080';

interface Input {
  readonly connectionId: string;
  readonly orgId: string;
}
interface Row {
  readonly id: string;
}

/** A driver that answers offline and writes down what `open()` was handed. */
const recordingDriver = (): ScrapeDriver & { readonly seen: SessionInit[] } => {
  const inner = fakeBrowser(PAGES);
  const seen: SessionInit[] = [];
  return {
    name: inner.name,
    seen,
    open: (init) => {
      seen.push(init);
      return inner.open(init);
    },
  };
};

let minted = 0;
const define = (over: Partial<ScrapeDefinition<Input, Row>> = {}): JobHandle<Input> => {
  minted += 1;
  return scrape<Input, Row>({
    name: `service-sync-${minted}`,
    input: t.object({ connectionId: t.string, orgId: t.string }),
    extract: t.object({ id: t.string }),
    idempotencyKey: ({ connectionId }) => `sync:${connectionId}`,
    tenant: ({ orgId }) => orgId,
    allowHosts: ['bank.test'],
    robots: { ignore: 'an offline driver: there is no origin to ask' },
    driver: fakeBrowser(PAGES),
    retry: { attempts: 1 },
    async run({ page, progress }) {
      progress(0, 1);
      await page.goto(ACCOUNTS);
      progress(1, 1, 'accounts');
      return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
    },
    ...over,
  });
};

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });
const workerOn = (queue: JobDriver, workerId = 'worker-a') =>
  createWorker({
    driver: queue,
    workerId,
    concurrency: 1,
    visibilityTimeoutMs: 30_000,
    heartbeatIntervalMs: 3_600_000,
    pollIntervalMs: 0,
    context,
    drainOnShutdown: false,
  });

let queue: JobDriver;
let enqueued = 0;
const enqueue = (handle: JobHandle<Input>, connectionId = 'conn-1') => {
  enqueued += 1;
  return queue.enqueue({
    name: handle.name,
    queue: 'default',
    input: { connectionId, orgId: ORG },
    idempotencyKey: `sync:${enqueued}`,
    maxAttempts: 1,
  });
};

beforeEach(() => {
  queue = createMemoryDriver();
  setEventBus(createMemoryEventBus());
  // No test below waits on a wall clock, and none sets a clock on its definition — the run takes
  // the process's, which is the seam. Real time, and every sleep one turn of the event loop.
  setScrapeClock(noWaitClock);
});

afterEach(() => {
  resetScrapeClock();
  resetEventBus();
  resetStorage();
  resetJobs();
});

describe('a run’s ending reaches the app', () => {
  test('completed: the report — rows and usage — is handed over, and progress was written', async () => {
    const seen: ScrapeSettled<Input, Row>[] = [];
    const handle = define({
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    const { id } = await enqueue(handle);

    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['completed']);

    const [settled] = seen;
    if (settled?.outcome !== 'completed') return expect.unreachable('expected a completed run');
    expect(settled.result.rows).toEqual([{ id: 'acct-1' }]);
    expect(settled.result.usage).toMatchObject({ navigations: 1, promptsAnswered: 0 });
    expect(settled.input).toEqual({ connectionId: 'conn-1', orgId: ORG });
    // The job's own `progress`, passed through to the scrape body.
    expect((await queue.introspect?.job(id))?.progress).toMatchObject({
      done: 1,
      total: 1,
      note: 'accounts',
    });
  });

  test('a login failure outside any prompt is told, by code, with what the attempt used', async () => {
    const seen: ScrapeSettled<Input, Row>[] = [];
    const handle = define({
      auth: {
        login: async ({ page }) => {
          await page.goto(LOGIN);
          await page.fill('#missing', 'x');
        },
      },
      pageTimeout: 50,
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    await enqueue(handle);

    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['dead-lettered']);

    const [settled] = seen;
    if (settled?.outcome !== 'dead-lettered') return expect.unreachable('expected a dead letter');
    expect(settled.code).toMatch(/^X_SCRAPE_/);
    // A failed run has no report and was billed all the same.
    expect(settled.usage).toMatchObject({ navigations: 1 });
  });

  test('a refused second run is told too — its body never ran, so it used nothing', async () => {
    const seen: ScrapeSettled<Input, Row>[] = [];
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const handle = define({
      concurrency: { key: ({ connectionId }) => connectionId, limit: 1, whenBusy: 'fail' },
      async run() {
        started += 1;
        await gate.promise;
        return [];
      },
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    await enqueue(handle);
    await enqueue(handle);

    const holding = workerOn(queue, 'worker-a').tick();
    while (started === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((await workerOn(queue, 'worker-b').tick()).map((run) => run.outcome)).toEqual([
      'refused',
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: 'refused', code: 'X_JOB_KEY_BUSY' });
    expect(seen[0]?.outcome === 'refused' ? seen[0].usage : 'unset').toBeUndefined();
    gate.resolve();
    await holding;
  });
});

describe('a prompt knows the run it is for', () => {
  test('the handler is handed the input, and login the run id', async () => {
    const asked: PromptRequest<Input>[] = [];
    const logins: string[] = [];
    const handle = define({
      auth: {
        login: async ({ page, prompt, runId }) => {
          logins.push(runId);
          await page.goto(LOGIN);
          await page.fill('#otp', await prompt('sms code'));
        },
      },
      prompt: (request) => {
        asked.push(request);
        return '482913';
      },
    });
    const { runId } = await enqueue(handle);

    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['completed']);

    expect(logins).toEqual([runId]);
    expect(asked.map((request) => [request.runId, request.input])).toEqual([
      [runId, { connectionId: 'conn-1', orgId: ORG }],
    ]);
  });
});

describe('the exit is resolved in the worker, never carried in the payload', () => {
  test('egress(input, ctx) looks the exit up; the stored job row holds no credential', async () => {
    const driver = recordingDriver();
    const orgs: unknown[] = [];
    const handle = define({
      driver,
      // By id, under the job's own tenant: what a sealed column on the connection row answers.
      egress: async ({ connectionId }, ctx) => {
        orgs.push(ctx.actor.orgId);
        await Promise.resolve();
        return connectionId === 'conn-1' ? EXIT : undefined;
      },
    });
    const { id } = await enqueue(handle);

    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['completed']);

    expect(driver.seen.map((init) => init.proxy)).toEqual([EXIT]);
    expect(orgs).toEqual([ORG]);
    const row = JSON.stringify(await queue.introspect?.job(id));
    expect(row).not.toContain('hunter2hunter2');
    expect(row).not.toContain('exit-7.test');
  });

  test('a credentialed exit that DID ride the payload is refused before the browser opens', async () => {
    const driver = recordingDriver();
    const handle = scrape<{ exit: string }, Row>({
      name: 'service-exit-in-payload',
      input: t.object({ exit: t.string }),
      extract: t.object({ id: t.string }),
      idempotencyKey: () => 'exit',
      tenant: 'none',
      allowHosts: ['bank.test'],
      robots: { ignore: 'an offline driver: there is no origin to ask' },
      driver,
      retry: { attempts: 3 },
      egress: ({ exit }) => exit,
      run: () => Promise.resolve([]),
    });
    const { id } = await queue.enqueue({
      name: handle.name,
      queue: 'default',
      input: { exit: EXIT },
      idempotencyKey: 'exit',
      maxAttempts: 3,
    });

    // Terminal: every remaining attempt would read the same row.
    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['dead-lettered']);
    const row = await queue.introspect?.job(id);
    expect(row?.lastError).toContain('X_SCRAPE_EGRESS_IN_PAYLOAD');
    // The refusal names the fix and never repeats the secret it found.
    expect(row?.lastError).not.toContain('hunter2hunter2');
    expect(driver.seen).toEqual([]);
  });
});

describe('the session disk is bound when it is used', () => {
  test('a store declared before defineStorage() writes sealed sessions to the app’s disk', async () => {
    // Declared FIRST, as a module evaluated before boot declares it.
    const handle = define({
      auth: {
        store: storageSessionStore(() => disk('sessions'), { keySource: KEYS }),
        key: ({ connectionId }) => connectionId,
        login: async ({ page }) => {
          await page.goto(LOGIN);
          await page.fill('#user', 'ada');
        },
      },
    });
    const sessions = memoryDriver();
    defineStorage({ disks: { sessions } });
    await enqueue(handle);

    expect((await workerOn(queue).tick()).map((run) => run.outcome)).toEqual(['completed']);

    const stored = [...sessions.objects().values()].map((bytes) => new TextDecoder().decode(bytes));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('"sealed":"x1.');
    expect(stored[0]).not.toContain('bank.test');
  });
});

describe('a test supplies the clock', () => {
  test('a prompt answered a moment later costs no wall-clock wait', async () => {
    const handle = define({
      auth: {
        login: async ({ page, prompt }) => {
          await page.goto(LOGIN);
          await page.fill('#otp', await prompt('sms code'));
        },
      },
      // A second between looks, five minutes of patience: on a real clock, a second per test.
      prompt: eventPrompt({ timeout: 300_000, pollMs: 1_000, keySource: KEYS }),
    });
    const { runId } = await enqueue(handle);
    const started = performance.now();

    const running = workerOn(queue).tick();
    // Published from "another process" a few turns after the run asked.
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await answerPrompt({ runId, index: 1, answer: '482913', keySource: KEYS });

    expect((await running).map((run) => run.outcome)).toEqual(['completed']);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
