// The ONE implementation of the page vocabulary, over the `ScrapeTarget` port. Real browser,
// recorded fixture and parsed HTML all reach `run()` through this file — so actionability, frame
// re-resolution, host enforcement and secret taint are written once and cannot drift between the
// driver a test uses and the driver production uses.

import type { Secret } from '@ultimat3/core';
import { isSecret, revealSecret } from '@ultimat3/core';
import type { ActionabilityState } from './actionability';
import { awaitActionable } from './actionability';
import type { ScrapeClock } from './clock';
import { deadline } from './clock';
import { hostBlocked, secretExposed, selectorMissing } from './error-throws';
import { hostDecision } from './hosts';
import type {
  CaptureRequest,
  DownloadRequest,
  ElementValue,
  ScrapeFrame,
  ScrapePage,
  WaitOptions,
} from './page';
import type { RobotsGate } from './robots';
import type { ScrapeSecrets } from './secrets';
import { safeHtml } from './secrets';
import type { ElementSnapshot, ScrapeCookie, ScrapeDownloadFile, ScrapeTarget } from './target';
import { ROOT_SELECTOR } from './target';

export interface PageContext {
  readonly clock: ScrapeClock;
  /**
   * Called before EVERY operation, poll included. This is what the wedge watchdog measures: the
   * gap between two of these is the definition of "the browser stopped answering", and putting
   * the hook here rather than in a wrapper means no page method can forget to report.
   */
  readonly onActivity?: (() => void) | undefined;
  /** Awaited before each navigation. `rate.ts` builds it; omitted means unpaced. */
  readonly pace?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  readonly allowHosts: readonly string[];
  readonly defaultTimeoutMs: number;
  readonly secrets?: ScrapeSecrets | undefined;
  readonly robots?: RobotsGate | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Mutable, shared by the page and every frame under it: a taint is a property of the SESSION. */
interface PageState {
  tainted: boolean;
}

type Resolve = () => Promise<ScrapeTarget>;

/** Every operation resolves its target through this, so every operation reports activity. */
const watched = (resolve: Resolve, ctx: PageContext): Resolve => {
  return () => {
    ctx.onActivity?.();
    return resolve();
  };
};

const plainText = (text: string | Secret): string => (isSecret(text) ? revealSecret(text) : text);

const toValue = (snapshot: ElementSnapshot): ElementValue => ({
  tag: snapshot.tag,
  text: snapshot.text,
  value: snapshot.value,
  attrs: snapshot.attrs,
});

async function first(resolve: Resolve, selector: string): Promise<ElementSnapshot | undefined> {
  const target = await resolve();
  return (await target.query(selector))[0];
}

function frameOver(
  rawResolve: Resolve,
  ctx: PageContext,
  state: PageState,
  seed: string,
): ScrapeFrame {
  const resolve = watched(rawResolve, ctx);
  let lastUrl = seed;
  const timeoutFor = (options: WaitOptions | undefined): number =>
    options?.timeout ?? ctx.defaultTimeoutMs;

  const wait = async (
    selector: string,
    options: WaitOptions | undefined,
    fallback: ActionabilityState,
  ): Promise<ElementSnapshot> => {
    const target = await resolve();
    lastUrl = target.url();
    return awaitActionable({
      selector,
      url: lastUrl,
      state: options?.state ?? fallback,
      timeoutMs: timeoutFor(options),
      clock: ctx.clock,
      signal: ctx.signal,
      snapshot: () => first(resolve, selector),
    });
  };

  return {
    url: () => lastUrl,
    waitFor: (selector, options) => wait(selector, options, 'actionable'),
    async click(selector, options): Promise<void> {
      await wait(selector, options, 'actionable');
      await (await resolve()).click(selector);
    },
    async type(selector, text, options): Promise<void> {
      await wait(selector, options, 'actionable');
      if (isSecret(text)) state.tainted = true;
      await (await resolve()).type(selector, plainText(text));
    },
    async fill(selector, text, options): Promise<void> {
      await wait(selector, options, 'actionable');
      const target = await resolve();
      await target.clear(selector);
      if (isSecret(text)) state.tainted = true;
      await target.type(selector, plainText(text));
    },
    async select(selector, values, options): Promise<void> {
      await wait(selector, options, 'actionable');
      await (await resolve()).select(selector, values);
    },
    async values(selector): Promise<readonly ElementValue[]> {
      return (await (await resolve()).query(selector)).map(toValue);
    },
    async text(selector): Promise<string> {
      const target = await resolve();
      if (selector === undefined) return (await target.query(ROOT_SELECTOR))[0]?.text ?? '';
      return (await target.query(selector))[0]?.text ?? '';
    },
    async html(): Promise<string> {
      return safeHtml(await (await resolve()).content(), ctx.secrets);
    },
    async count(selector): Promise<number> {
      return (await (await resolve()).query(selector)).length;
    },
    async evaluate(expression): Promise<unknown> {
      return (await resolve()).evaluate(expression);
    },
    frame(nameOrSelector): ScrapeFrame {
      // The resolver, not the frame. Every call through the returned handle runs this again, so
      // a handle taken before a re-navigation addresses the CURRENT frame with that name and
      // never a detached one — the trap `frameLocator`-style handles set for every caller.
      const resolveChild = async (): Promise<ScrapeTarget> => {
        const budget = deadline(ctx.clock, ctx.defaultTimeoutMs);
        for (;;) {
          const parent = await resolve();
          const found = (await parent.frames()).find(
            (ref) =>
              ref.name === nameOrSelector ||
              ref.selector === nameOrSelector ||
              ref.url === nameOrSelector,
          );
          if (found !== undefined) return found.target;
          if (budget.expired()) {
            throw selectorMissing(nameOrSelector, parent.url(), ctx.defaultTimeoutMs);
          }
          await ctx.clock.sleep(Math.min(50, budget.remainingMs()), ctx.signal);
        }
      };
      return frameOver(resolveChild, ctx, state, lastUrl);
    },
  };
}

/**
 * Refused BEFORE the navigation, not reported after it. An `allowHosts` consulted afterwards is a
 * log line about a request that already left the container.
 */
async function guardNavigation(url: string, ctx: PageContext): Promise<void> {
  const decision = hostDecision(url, ctx.allowHosts);
  if (!decision.allowed) throw hostBlocked(url, ctx.allowHosts);
  await ctx.robots?.assertAllowed(url);
}

export function pageOverTarget(target: ScrapeTarget, ctx: PageContext): ScrapePage {
  const state: PageState = { tainted: false };
  const frame = frameOver(() => Promise.resolve(target), ctx, state, target.url());
  const capture = async (
    kind: 'screenshot' | 'pdf',
    options: CaptureRequest | undefined,
  ): Promise<Uint8Array> => {
    // The leak nobody remembers: a screenshot of a filled login form IS the password, in pixels,
    // in object storage, forever. Refused rather than masked — a mask over pixels is a guess
    // about layout, and `page.html()` already gives a redacted artifact that is exact.
    if (state.tainted) throw secretExposed(kind, target.url());
    const request = { fullPage: options?.fullPage };
    return kind === 'screenshot' ? target.screenshot(request) : target.pdf(request);
  };
  return {
    ...frame,
    // The DOCUMENT's URL is asked of the target, never of the frame's cached `lastUrl`. `ScrapeFrame`
    // resolves its target asynchronously and `url()` is synchronous, so a child frame can only ever
    // answer from a cache refreshed on its last wait — but the page HOLDS its target, so it has no
    // such excuse. Spreading `...frame` without this override made `page.url()` answer the seed
    // (`about:blank`) after every `goto`, which is what `x shot` reported as `finalUrl`.
    url: () => target.url(),
    async goto(url, options): Promise<void> {
      await guardNavigation(url, ctx);
      await ctx.pace?.(ctx.signal);
      ctx.onActivity?.();
      await target.goto(url, {
        timeoutMs: options?.timeout ?? ctx.defaultTimeoutMs,
        signal: ctx.signal,
      });
    },
    screenshot: (options) => capture('screenshot', options),
    pdf: (options) => capture('pdf', options),
    // `async`, and that is the whole point of the keyword here: `ScrapeTarget` is the seam a third
    // party implements, and a driver that THROWS from its promise-typed `download()` would escape
    // past this page's caller `.catch()` if the forward were a bare arrow.
    async download(options?: DownloadRequest): Promise<ScrapeDownloadFile> {
      return await target.download({ timeoutMs: options?.timeout ?? ctx.defaultTimeoutMs });
    },
    cookies: (): Promise<readonly ScrapeCookie[]> => target.cookies(),
    session: () => target.session(),
    console: () => target.console.entries(),
    pageErrors: () => target.pageErrors.entries(),
    network: () => target.network.entries(),
    networkDropped: () => target.network.dropped,
    pageErrorsDropped: () => target.pageErrors.dropped,
  };
}
