# @ultimat3/scraping

Browser automation as a **job**. `scrape()` returns a `JobHandle` — one row of
`PRIMITIVE_FACTORIES` in `@ultimat3/core`, the derived list of every factory that ships. There is
no ninth primitive, and no ordinal here to go stale when the next factory lands.

```ts
import { t } from '@ultimat3/schema';
import type { StorageDriver } from '@ultimat3/storage';
import { scrape, storageSessionStore } from '@ultimat3/scraping';

declare const disk: StorageDriver;

const orderPage = t.object({
  rows: t.array(t.object({ id: t.string, total: t.number })),
  hasMore: t.boolean,
});

export const dailyOrders = scrape({
  name: 'orders.daily',
  input: t.object({ orgId: t.uuid, day: t.string }),
  extract: t.object({ id: t.string, total: t.number }),
  idempotencyKey: ({ orgId, day }) => `orders:${orgId}:${day}`,
  tenant: ({ orgId }) => orgId,
  allowHosts: ['shop.example.com', '*.api.example.com'],
  block: ['image', 'media', 'font'],
  rate: 1,
  robots: 'obey',
  secrets: ['SHOP_PASSWORD'],
  expect: { minRows: 1, maxDrop: 0.5 },
  auth: {
    store: storageSessionStore(disk),
    login: async ({ page, secrets, prompt }) => {
      await page.goto('https://shop.example.com/login');
      await page.fill('#user', 'ops@example.com');
      await page.fill('#pass', secrets.get('SHOP_PASSWORD'));
      await page.click('#submit');
      await page.fill('#otp', await prompt('sms code'));
    },
    validate: async ({ page }) => (await page.count('#logout')) > 0,
  },
  async run({ page, http, step }) {
    await page.goto('https://shop.example.com/orders');
    const rows: { id: string; total: number }[] = [];
    for (let pageNumber = 1; ; pageNumber += 1) {
      // One `step.run` per page: a killed worker resumes at the page it stopped on. What a step
      // persists is a CURSOR — never a page, never a live handle, never a session.
      const batch = await step.run(`page:${pageNumber}`, async () =>
        (await http.request(`https://api.example.com/orders?page=${pageNumber}`)).parse(orderPage),
      );
      rows.push(...batch.rows);
      if (!batch.hasMore) break;
    }
    return rows;
  },
});
```

## Why a job

| A scrape has | So it is |
|---|---|
| an input schema, a tenant, a retry policy, a timeout, a queue, a concurrency cap | a `job` |
| a **required** idempotency key | a `job` — re-logging into a bank after a worker kill is the exact bug; three wrong attempts locks the account |
| `step.run` checkpoints, because recovery must resume at the broken page | a `job` |

It therefore inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show`
and its manifest row without a line of code here.

## The two transports, one session

Drive the **browser** through login, 2FA and navigation; then reverse-engineer the site's own JSON
endpoints and pull the bulk over **HTTP**. `http` is session-bound, never a bare `fetch`: the
browser's cookies, headers and proxy, the same `allowHosts`, the same robots gate, the same rate
limit, the same cancellation. `page.session()` exposes the handoff so an author can see what
carried over.

The jar is scoped per request, RFC 6265: a cookie stored for `bank.test` is sent to `bank.test`
and to nothing else — not `evilbank.test`, not `sub.bank.test` — and only a domain-scoped
`.bank.test` reaches subdomains. `SessionSnapshot.headers` is the one field the real driver cannot
fill (CDP exposes no read for it, and `driver-parity.test.ts` pins that): a token the HTTP leg must
carry goes on the request, `http.request(url, { headers })`.

Both legs replay from **one** fixture directory (`fixtureBrowser(dir)`), so a hybrid run — browser
login, session handoff, HTTP bulk fetch — is tested end to end. Both legs apply the same robots
gate, offline included.

## What the page reports back, and the one thing a picture cannot say

Three bounded rings, read off `ScrapePage`. Bounded because a ten-thousand-page run that kept
every line holds the whole browsing history in the worker's heap — and each read says how much the
bound threw away, so a count taken from one is never quietly a floor.

| Read | Answers |
|---|---|
| `page.console()` | `ConsoleLine[]` — what the page LOGGED |
| `page.pageErrors()` / `page.pageErrorsDropped()` | `PageError[]` — what the page THREW and nobody caught, with the `stack` when the exception carried one |
| `page.network()` / `page.networkDropped()` | `NetworkEntry[]` — every request, refusals included |

`console()` and `pageErrors()` are separate streams because they are separate events: an island
that throws during hydration calls no console method, so a scrape reading the console alone sees a
page that looks silent and is broken — and a screenshot of it is a picture of the server-rendered
markup, indistinguishable from one that worked.

Empty is a legitimate answer, never a missing method: the offline drivers parse markup and execute
none of it, so nothing there can throw. `ScrapeTarget.pageErrors` is a **required** ring for the
same reason — a third-party driver that could omit it would be silent about errors it can see.
Entries are built with `pageErrorEntry()`, which truncates at `MAX_PAGE_ERROR_CHARS`: the ring
bounds the count, and one `Maximum call stack size exceeded` is thousands of frames.

## What it owns

| Module | Owns |
|---|---|
| `scrape.ts` / `scrape-run.ts` | the factory over `job()`, and one attempt's assembly |
| `page.ts` / `page-over-target.ts` | the driver-blind vocabulary, implemented once |
| `target.ts` / `driver.ts` | the two seams: what a driver answers, and what a session is |
| `driver-cdp.ts` / `cdp-*.ts` | the real browser, over a structural CDP port |
| `driver-fake.ts` / `driver-fixture.ts` / `html-*.ts` | the offline drivers, on Bun's `HTMLRewriter` |
| `http.ts` / `http-recorded.ts` | the second transport, live and replayed |
| `auth.ts` / `session-state.ts` | acquire → persist → reuse → validate → burn |
| `expect.ts` | the silent-green alarm |
| `watchdog.ts` | the wedge and zombie discipline |
| `errors.ts` / `error-throws.ts` | this package's `X_*` codes and their retry classification |

## Extending it — there is no plugin API, and none is needed

Two mechanisms, both of which the framework already ships:

**1. The driver seam.** `ScrapeDriver` is the extension point, exactly as `jobs`' driver is.
Everything a third-party driver needs is a named export of `src/index.ts`:

```ts
import {
  pageOverTarget,
  type ScrapeDriver,
  type ScrapeHttp,
  type ScrapeSession,
  type ScrapeTarget,
  type SessionInit,
} from '@ultimat3/scraping';

interface MyOptions {
  readonly endpoint: string;
}

// Implement `ScrapeTarget` — twelve methods, all driver-blind — and the vocabulary above it,
// actionability and frame re-resolution included, comes from `pageOverTarget` unchanged.
declare function myTarget(options: MyOptions, init: SessionInit): Promise<ScrapeTarget>;
declare function myHttp(target: ScrapeTarget, init: SessionInit): ScrapeHttp;

export const myBrowser = (options: MyOptions): ScrapeDriver => ({
  name: 'my-browser',
  async open(init: SessionInit): Promise<ScrapeSession> {
    const target = await myTarget(options, init);
    return {
      driver: 'my-browser',
      page: pageOverTarget(target, {
        clock: init.clock,
        allowHosts: init.rules.allowHosts,
        defaultTimeoutMs: init.timeoutMs,
        secrets: init.secrets,
        robots: init.robots,
        signal: init.signal,
      }),
      http: myHttp(target, init),
      close: () => target.close(),
    };
  },
});
```

**2. Primitives are functions returning values.** An app's house style is a wrapper, not a fork:

```ts
// apps/web/shared/base/bank-scrape.ts — the app's convention, written once
import type { JobHandle } from '@ultimat3/jobs';
import type { StorageDriver } from '@ultimat3/storage';
import { scrape, type ScrapeDefinition } from '@ultimat3/scraping';

declare const disk: StorageDriver;

export const bankScrape = <I, R>(over: ScrapeDefinition<I, R>): JobHandle<I> =>
  scrape<I, R>({
    robots: 'obey',
    rate: 0.5,
    block: ['image', 'media', 'font'],
    expect: { minRows: 1, maxDrop: 0.5 },
    artifacts: { storage: disk },
    ...over,
  });
```

Nothing downstream can tell the difference: the value is still a `JobHandle`, so the registry, the
manifest and `x jobs show` work on it unchanged.

Where a genuine hook is needed it is a **declared callback field** on the definition — `recover`,
`auth.login`, `auth.validate`, `prompt` — typed, discoverable, one per concern. Never a global
register-a-plugin call ([`docs/idea/19-mechanism-not-convention.md`](../../docs/idea/19-mechanism-not-convention.md)).

## What does NOT ship, and why

| Not shipped | Reason |
|---|---|
| stealth payloads | a framework-shipped payload is a shared, fingerprintable signature handed to every user. Two independent teams reached the same conclusion — one moved stealth into a Chromium fork, another *removed* an injected script because the injection was itself detectable. The hook ships; the payload never does |
| captcha solving | same argument, plus it is not a mechanism — it is a business decision about somebody else's site |
| credential stuffing, lockout-defeating retry | `X_SCRAPE_AUTH_FAILED` is **terminal**, and the refusal is written into the session record so the next attempt fails before reaching a login form. A site that locks an account after three wrong attempts makes a retrying framework the thing that destroys the user's account |
| a `puppeteer-core` dependency | the launcher is passed in (`localBrowser({ launcher: puppeteer })`), the port is structural, and no puppeteer type can reach the vocabulary |

## Errors

Every code carries a cause, a runnable `fix:` and a retry classification — see `src/errors.ts`.
`X_SCRAPE_YIELD_COLLAPSED`, `X_SCRAPE_AUTH_FAILED`, `X_SCRAPE_BLOCKED` and `X_SCRAPE_PAGE_CRASHED`
are the four worth knowing by heart.

## Boundary

Tier 5. May import tiers 0-4 only — enforced by `bun run scripts/boundaries.ts`.
