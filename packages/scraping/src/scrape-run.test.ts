// One attempt's assembly, at the two places it decides something a scrape body cannot see: which
// session key this run owns, and what the report says about requests interception refused.
//
// The session key is a TENANCY boundary — a session is credential material, and two tenants
// sharing one key share an authenticated browser session — so it is pinned here rather than left
// to `sessionKeyFor`'s unit test, which cannot see who calls it with what.

import { describe, expect, test } from 'bun:test';
import { createContext, createLogger, userActor } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { testClock } from './clock';
import { resetScrapeDriver } from './driver';
import { fakeBrowser } from './driver-fake';
import type { ScrapeDefinition, ScrapeReport } from './scrape';
import { runScrape } from './scrape-run';
import type { ScrapeSessionStore, SessionState } from './session-state';

const URL_A = 'https://shop.test/orders';
const HTML = '<html><body><ul><li class="row" data-id="1">One</li></ul></body></html>';

const passThroughStep = (): StepApi =>
  ({
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  }) as unknown as StepApi;

const runArgs = (orgId: string | undefined): JobRunArgs<{ page: number }> => ({
  input: { page: 1 },
  step: passThroughStep(),
  ctx: createContext({
    logger: createLogger({ writer: () => undefined }),
    ...(orgId === undefined ? {} : { actor: userActor({ id: 'u-1', orgId }) }),
  }),
  attempt: 1,
  jobId: 'job-1',
  runId: 'run-1',
});

/** Records every key written, which is the only place the plan's key is observable from outside. */
const recordingStore = (): ScrapeSessionStore & { readonly keys: readonly string[] } => {
  const keys: string[] = [];
  const states = new Map<string, SessionState>();
  return {
    keys,
    load: (key) => Promise.resolve(states.get(key)),
    save: (state) => {
      keys.push(state.key);
      states.set(state.key, state);
      return Promise.resolve();
    },
    burn: (key) => {
      states.delete(key);
      return Promise.resolve();
    },
  };
};

const define = (
  over: Partial<ScrapeDefinition<{ page: number }, { id: string }>> = {},
): ScrapeDefinition<{ page: number }, { id: string }> => ({
  name: 'orders',
  input: t.object({ page: t.number }),
  extract: t.object({ id: t.string }),
  idempotencyKey: (input) => `orders:${String(input.page)}`,
  tenant: 'none',
  allowHosts: ['shop.test'],
  clock: testClock(),
  driver: fakeBrowser([{ url: URL_A, html: HTML }]),
  async run({ page }) {
    await page.goto(URL_A);
    return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
  },
  ...over,
});

const keyAfterLogin = async (
  store: ScrapeSessionStore & { readonly keys: readonly string[] },
  orgId: string | undefined,
  key?: (input: { page: number }) => string,
): Promise<string | undefined> => {
  await runScrape(
    define({
      auth: { store, login: () => Promise.resolve(), ...(key === undefined ? {} : { key }) },
    }),
    runArgs(orgId),
  );
  return store.keys.at(-1);
};

describe('unit · the session key is a tenancy boundary, and auth.key discriminates INSIDE it', () => {
  test('two tenants with the SAME auth.key get different session keys', async () => {
    const store = recordingStore();
    const first = await keyAfterLogin(store, 'org-1', () => 'shared');
    const second = await keyAfterLogin(store, 'org-2', () => 'shared');
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
    expect(first?.startsWith('org-1/')).toBe(true);
    expect(second?.startsWith('org-2/')).toBe(true);
  });

  test('two accounts inside ONE tenant get different session keys — what auth.key is for', async () => {
    const store = recordingStore();
    const first = await keyAfterLogin(store, 'org-1', () => 'account-a');
    const second = await keyAfterLogin(store, 'org-1', () => 'account-b');
    expect(first).toBe('org-1/orders/account-a');
    expect(second).toBe('org-1/orders/account-b');
  });

  test('no auth.key is the tenant default, unchanged', async () => {
    const store = recordingStore();
    expect(await keyAfterLogin(store, 'org-1')).toBe('org-1/orders/default');
  });

  test('a discriminator cannot escape the key space — separators and NUL are stripped', async () => {
    const store = recordingStore();
    // The key is also a storage path. Before this ran through `sessionKeyFor`, an `auth.key`
    // returning a path was written to the store verbatim, unsanitised.
    const escaped = await keyAfterLogin(store, 'org-1', () => '../../etc/passwd\0');
    expect(escaped?.split('/')).toHaveLength(3);
    expect(escaped).toBe('org-1/orders/..-..-etc-passwd-');
  });
});

describe('unit · the refusal count says when it is not the whole count', () => {
  test('a run whose network ring overflowed reports the drop, so `refused` reads as a floor', async () => {
    // 250 refusals into a 200-entry ring: the ring is bounded on purpose (a scrape of ten thousand
    // pages must not hold its whole browsing history), so the count taken from it is a FLOOR and
    // the report has to say so — otherwise "5,000 images blocked" prints as 200 with no hint.
    const many = Array.from(
      { length: 250 },
      (_, index) => `<img src="https://tracker.test/${String(index)}.gif">`,
    ).join('');
    const report = (await runScrape(
      define({
        driver: fakeBrowser([{ url: URL_A, html: `<html><body>${many}</body></html>` }]),
        run: async ({ page }) => {
          await page.goto(URL_A);
          return [];
        },
      }),
      runArgs('org-1'),
    )) as ScrapeReport<{ id: string }>;
    expect(report.refused).toBe(200);
    expect(report.networkDropped).toBe(51);
  });
});

describe('unit · a run with no driver at all says so', () => {
  test('the cause names the SCRAPE as a scrape, never as a driver nobody named', async () => {
    resetScrapeDriver();
    const { driver: _dropped, ...bare } = define();
    let cause: string | undefined;
    try {
      await runScrape(bare, runArgs('org-1'));
    } catch (thrown) {
      cause = (thrown as { cause?: string }).cause;
    }
    // The old cause read `no scrape driver named "orders" is installed`, which sends its reader
    // hunting for a driver called "orders" — the scrape's own name.
    expect(cause).toContain('scrape "orders"');
    expect(cause).not.toContain('named "orders"');
  });
});
