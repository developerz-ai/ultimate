// RUNS the named-proxy-pool recipe on `wiki/Building-Your-Own-Base.md`: one subject always leaves
// through one exit, the subjects spread over every exit, an empty pool is the recipe's own refusal,
// and a real `runScrape` hands the driver the pool's exit as the session's proxy.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ctxOf, frozenClock, structuredLogger } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { fakeBrowser, runScrape, type ScrapeDriver, type SessionInit } from '@ultimat3/scraping';
import { exportsOf, type LoadedRecipe, loadRecipe } from '../lib/base-recipes';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from '../lib/run';

// Reads the wiki page and compiles its fences, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Input {
  readonly connectionId: string;
}

interface ProxyRecipe {
  proxyPool<I>(
    name: string,
    stickyBy: (input: I) => string,
  ): { readonly name: string; readonly variable: string; egress(input: I): string };
}

const VARIABLE = 'PROXY_POOL_RESIDENTIAL';
const EXITS = ['http://exit-1.test:8080', 'http://exit-2.test:8080', 'http://exit-3.test:8080'];
const URL_A = 'https://shop.test/orders';
const before = Bun.env[VARIABLE];

let loaded: LoadedRecipe;
let pool: ReturnType<ProxyRecipe['proxyPool']>;

beforeAll(async () => {
  loaded = await loadRecipe(repoRoot(), 'apps/web/shared/base/proxy-pool.ts');
  const recipe = exportsOf<ProxyRecipe>(loaded, ['proxyPool']);
  pool = recipe.proxyPool<Input>('residential', (input) => input.connectionId);
  Bun.env[VARIABLE] = EXITS.join(', ');
});

afterAll(async () => {
  if (before === undefined) delete Bun.env[VARIABLE];
  else Bun.env[VARIABLE] = before;
  await loaded.dispose();
});

const ids = Array.from({ length: 30 }, (_, index) => `conn_${index}`);

/** An offline driver that writes down what `open()` was handed. */
const recordingDriver = (): ScrapeDriver & { readonly seen: SessionInit[] } => {
  const inner = fakeBrowser([{ url: URL_A, html: '<p class="row" data-id="1">One</p>' }]);
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

const runArgs = (input: Input): JobRunArgs<Input> => ({
  input,
  step: {
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  } as unknown as StepApi,
  ctx: ctxOf({ logger: structuredLogger({ writer: () => undefined }) }),
  attempt: 1,
  finalAttempt: false,
  progress: () => undefined,
  jobId: 'job-1',
  runId: 'run-1',
});

describe('recipe · a named proxy pool', () => {
  test('the pool reads its own variable, and one subject keeps one exit', () => {
    expect(pool.variable).toBe(VARIABLE);
    for (const id of ids) {
      const exit = pool.egress({ connectionId: id });
      expect(EXITS).toContain(exit);
      expect(pool.egress({ connectionId: id })).toBe(exit);
    }
  });

  test('the subjects spread over every exit', () => {
    const used = new Set(ids.map((id) => pool.egress({ connectionId: id })));
    expect([...used].sort()).toEqual(EXITS);
  });

  test('an empty pool is the recipe’s own terminal refusal, naming the variable', () => {
    Bun.env[VARIABLE] = ' , ';
    try {
      expect(() => pool.egress({ connectionId: 'conn_1' })).toThrow(
        expect.objectContaining({ code: 'X_PROXY_POOL_EMPTY' }),
      );
    } finally {
      Bun.env[VARIABLE] = EXITS.join(', ');
    }
  });

  test('a scrape declaring the pool hands the driver that subject’s exit', async () => {
    const driver = recordingDriver();
    await runScrape(
      {
        name: 'orders',
        input: t.object({ connectionId: t.string }),
        extract: t.object({ id: t.string }),
        idempotencyKey: (input) => input.connectionId,
        tenant: 'none',
        allowHosts: ['shop.test'],
        clock: frozenClock(),
        robots: { ignore: 'offline fixture, no origin to ask' },
        driver,
        egress: pool.egress,
        async run({ page }) {
          await page.goto(URL_A);
          return (await page.values('.row')).map((row) => ({ id: row.attrs['data-id'] ?? '' }));
        },
      },
      runArgs({ connectionId: 'conn_9' }),
    );
    expect(driver.seen[0]?.proxy).toBe(pool.egress({ connectionId: 'conn_9' }));
  });
});
