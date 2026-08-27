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

## Reading elements, frames, and the network condition

| Read | Answers |
|---|---|
| `page.values(selector)` | `ElementValue[]` — tag, text, value, attrs. The projection row assembly wants |
| `page.query(selector)` | `ElementSnapshot[]` — the same matches PLUS `visible`, `enabled`, and the layout `box`/`hitTarget` a driver with a layout engine can answer. The read for a decision ABOUT an element |
| `page.frame(nameOrSelector)` | a `ScrapeFrame`, re-resolved on every call through it |
| `page.offline(enabled)` | cuts the BROWSER's network, or restores it |
| `page.colorScheme(scheme)` | what the browser reports as the user's OS colour preference — `'light'`, `'dark'`, or `'no-preference'` to CLEAR the override |

`query()` exists because there is exactly one definition of "visible" in this framework and it is
the port's. A caller that had to compute its own wrote
`display !== 'none' && visibility !== 'hidden' && opacity !== '0'` a second time, which is the
copy axiom 1 forbids.

**A frame verb reaches the FRAME.** `fill`, `type`, `select`, `clear`, `click` and `query` through
a `ScrapeFrame` handle all address that frame's own document — never the parent's, even when the
two carry the same ids, which is what an iframe'd SSO login looks like. `driver-parity-frames.test.ts`
drives all six through a frame on all three drivers. The one thing an offline driver cannot do is
NAVIGATE a frame: a recorded frame is one static document, so a click inside one moves nothing
(and, in particular, never moves the parent).

**`page.offline()` is set on a browser or refused by name.** The offline drivers answer
`X_NOT_IMPLEMENTED` rather than resolving: patching `fetch` in a test process cannot reach a
browser's own requests, so a driver that quietly answered "done" would let "a like taken offline is
queued" pass against an app that was online for the whole test.

**`page.colorScheme()` sets the INPUT to a theme decision, never its outcome.** An attribute on the
document — `data-theme`, `class="dark"` — is the outcome, and the component owns it: one that
resolves `'system'` itself overwrites or deletes the attribute on mount, so a harness that set it is
silently overruled. Measured on `examples/dummy`, `As of 2026-08`: `x shot --island` photographed
every state in both themes and the two files came back byte-identical, same md5, from two addresses
that really did serve different documents. Emulating the preference is what reaches a component that
decides for itself; set the attribute as well for one that reads a theme it does not own.

**`'no-preference'` CLEARS the override, and is not a third value.** CDP treats an explicit
`prefers-color-scheme: no-preference` as an override and an EMPTY feature list as a reset, so that
is what this sends. Measured on Chrome 150 headless, `As of 2026-08`: after either one,
`(prefers-color-scheme: dark)` is false and `(prefers-color-scheme: light)` is true — the same
answers an untouched page gives. They diverge on a browser that has a real preference, where the
override forces the light answer and the reset gives the machine's own back, which is what this
value promises. (`no-preference` left the `prefers-color-scheme` query itself in 2020, so nothing
matches it in any of those readings.)

Accepted and RECORDED on the offline drivers rather than refused, which is the opposite of
`offline()` — and the line between them is which side of a capture the verb is on. An offline
*assertion* is reachable on a driver that answers content, so a resolved `setOfflineMode` would let
it pass against an app that never went offline; a colour preference has no such assertion, and the
only thing it could be wrong about is a picture. So the offline drivers answer **different
deterministic bytes per scheme**, exactly as they already do per `clip` — a fake returning one
constant for both themes is precisely what let the defect above ship.

## What the page reports back, and the one thing a picture cannot say

Three bounded rings, read off `ScrapePage`. Bounded because a ten-thousand-page run that kept
every line holds the whole browsing history in the worker's heap — and each read says how much the
bound threw away, so a count taken from one is never quietly a floor.

| Read | Answers |
|---|---|
| `page.console()` | `ConsoleLine[]` — what the page LOGGED |
| `page.pageErrors()` / `page.pageErrorsDropped()` | `PageError[]` — what the page THREW and nobody caught, with the `stack` when the exception carried one |
| `page.network()` / `page.networkDropped()` | `NetworkEntry[]` — every request, refusals included |

All three are **redacted by value** on the way out, the same pass `page.html()` makes: a login
endpoint fetched with the password in its query string, or a site that logs the credential it
rejected, would otherwise put the value in `page.network()`/`page.console()` verbatim and from
there into the stored failure artifact. The HTTP leg's `X_SCRAPE_HTTP_FAILED` cause is redacted
too, at its throw site. Values shorter than `MIN_REDACTABLE_LENGTH` are not — a 3-character PIN is
a substring of ordinary prose — and pixels never can be, which is why a typed secret TAINTS the
page and `screenshot()`/`pdf()` are refused outright.

`console()` and `pageErrors()` are separate streams because they are separate events: an island
that throws during hydration calls no console method, so a scrape reading the console alone sees a
page that looks silent and is broken — and a screenshot of it is a picture of the server-rendered
markup, indistinguishable from one that worked.

Empty is a legitimate answer, never a missing method: the offline drivers parse markup and execute
none of it, so nothing there can throw. `ScrapeTarget.pageErrors` is a **required** ring for the
same reason — a third-party driver that could omit it would be silent about errors it can see.
Entries are built with `pageErrorEntry()`, which truncates at `MAX_PAGE_ERROR_CHARS`: the ring
bounds the count, and one `Maximum call stack size exceeded` is thousands of frames.

### A picture of ONE component

`page.screenshot({ clip: { x, y, width, height } })` crops to a rectangle in the page's own
coordinate space — the space `getBoundingClientRect()` answers in. It exists because the reader of
a scrape's screenshot is increasingly a vision model, whose pixels are the scarce resource: a
whole-viewport picture spends them on everything that is not the component under review.

| Framing | Answer |
|---|---|
| neither | the viewport, exactly as before the clip existed — byte for byte |
| `fullPage: true` | the whole document |
| `clip` | that rectangle |
| **both** | `X_SCRAPE_CAPTURE_INVALID` — a browser honours one of the two without saying which |
| `clip` with no area, or entirely in negative coordinates | `X_SCRAPE_CAPTURE_INVALID` — a blank picture that reads as a successful capture is the failure this exists to remove |
| `clip` on `page.pdf()` | `X_SCRAPE_CAPTURE_INVALID` — a print engine paginates the document and has no crop |

A rectangle **below the fold is accepted**. It is not checked against a viewport: this package
neither sets nor reads one, and a component under the fold is the case a component crop is for.

The offline drivers honour it, so the crop is provable with no Chrome — `fakeBrowser()` answers
different deterministic bytes per rectangle, which is what lets a component screenshot be tested
on a machine with no browser — the case CI is.

## What it owns

| Module | Owns |
|---|---|
| `scrape.ts` / `scrape-run.ts` | the factory over `job()`, and one attempt's assembly |
| `page.ts` / `page-over-target.ts` | the driver-blind vocabulary, implemented once |
| `target.ts` / `driver.ts` | the two seams: what a driver answers, and what a session is |
| `driver-cdp.ts` / `cdp-*.ts` | the real browser, over a structural CDP port |
| `driver-fake.ts` / `driver-fixture.ts` / `html-*.ts` | the offline drivers, on Bun's `HTMLRewriter` |
| `http.ts` / `http-recorded.ts` | the second transport, live and replayed |
| `auth.ts` / `session-state.ts` | acquire → persist → reuse → validate → burn. The session key encodes each part (`<sanitised>.<digest>`), so two account names that differ only outside `[a-zA-Z0-9._-]` are two sessions |
| `secrets.ts` / `browser-record.ts` | what may leave this package, and how a browser's own string map is read |
| `expect.ts` | the silent-green alarm |
| `watchdog.ts` | the wedge and zombie discipline |
| `capture-clip.ts` | the one framing rule — crop, whole page, or a refusal — checked before any driver sees it |
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
