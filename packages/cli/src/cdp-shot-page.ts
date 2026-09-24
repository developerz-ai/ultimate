// One `ShotPage` over one attached CDP session: navigate, read, act, photograph. The session is
// the driver's (`cdp-shot-driver.ts`), the rings and the allow list are `cdp-shot-watch.ts`'s, and
// what "ready to act on" means is `cdp-shot-element.ts`'s. Acts are real input — a click is a
// mouse press at the element's centre, a keystroke is a key event — because an in-page `.click()`
// skips `pointerdown`, which is what a dialog's backdrop listens to.
import { assert, finiteCount, hostDecision } from '@ultimat3/core';
import type { CdpConnection } from '@ultimat3/testing';
import { CdpCallFailedError, CdpTimeoutError } from '@ultimat3/testing';
import type {
  ElementSnapshot,
  ShotCapture,
  ShotColorScheme,
  ShotPage,
  ShotSessionInit,
  WaitOptions,
} from './browser-launcher-port';
import { axNodesFor } from './cdp-shot-a11y';
import { awaitReady, parseSnapshots, snapshotExpression } from './cdp-shot-element';
import { ShotHostRefusedError } from './cdp-shot-errors';
import { characterFrames, chordFrames, parseKeyChord } from './cdp-shot-keys';
import type { PageWatch } from './cdp-shot-watch';

export const DEFAULT_ACCESSIBILITY_MAX = 25;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** What the page threw, when `Runtime.evaluate` answered with an exception rather than a value. */
const thrownIn = (answer: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const thrown = record(answer?.['exceptionDetails']);
  if (thrown === undefined) return undefined;
  const description = record(thrown['exception'])?.['description'];
  if (typeof description === 'string') return description.split('\n')[0];
  const text = thrown['text'];
  return typeof text === 'string' ? text : 'the expression threw in the page';
};

const selectorArg = (selector: string): string => JSON.stringify(selector);

export interface CdpShotPageInput {
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly init: ShotSessionInit;
  readonly watch: PageWatch;
}

export function cdpShotPage(input: CdpShotPageInput): ShotPage {
  const { connection, sessionId, init, watch } = input;
  const defaultTimeout = finiteCount(init.name, 'timeoutMs', init.timeoutMs, 1);
  const send = async (method: string, params: Record<string, unknown> = {}) =>
    (await connection.send(method, params, sessionId)).result;
  let current = 'about:blank';

  const evaluate = async (expression: string): Promise<unknown> => {
    const answer = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const threw = thrownIn(answer);
    if (threw !== undefined) {
      throw new CdpCallFailedError({ method: 'Runtime.evaluate', detail: threw });
    }
    return record(answer?.['result'])?.['value'];
  };

  const query = async (selector: string): Promise<readonly ElementSnapshot[]> =>
    parseSnapshots(await evaluate(snapshotExpression(selector)));

  const ready = (
    selector: string,
    options: WaitOptions | undefined,
    before?: () => Promise<unknown>,
  ): Promise<ElementSnapshot> =>
    awaitReady({
      selector,
      state: options?.state ?? 'actionable',
      timeoutMs: finiteCount('page.waitFor', 'timeout', options?.timeout ?? defaultTimeout, 1),
      clock: init.clock,
      url: () => current,
      snapshot: async () => {
        await before?.();
        return (await query(selector))[0];
      },
    });

  const key = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
    await send('Input.dispatchKeyEvent', { ...frame });
  };

  const focusOn = (selector: string): Promise<unknown> =>
    evaluate(`document.querySelector(${selectorArg(selector)})?.focus()`);

  return {
    url: () => current,
    async goto(url, options) {
      if (!hostDecision(url, init.rules.allowHosts).allowed) {
        throw new ShotHostRefusedError({ url, allowHosts: init.rules.allowHosts });
      }
      const timeoutMs = finiteCount('page.goto', 'timeout', options?.timeout ?? defaultTimeout, 1);
      // The waiter goes up BEFORE the send, and the reply is raced rather than awaited: Chrome
      // drops `Page.navigate`'s reply when the navigation swaps the render process
      // (`@ultimat3/testing`'s `cdp-e2e-page.ts` measured it), and the load event still fires.
      const loaded = connection.once('Page.loadEventFired', sessionId, timeoutMs);
      const answered = send('Page.navigate', { url }).then(
        (answer) => {
          const failed = answer?.['errorText'];
          return typeof failed === 'string' && failed !== '' ? failed : undefined;
        },
        () => undefined,
      );
      const first = await Promise.race([
        loaded.then((fired) => ({ fired, failed: undefined })),
        answered.then((failed) => ({ fired: undefined, failed })),
      ]);
      if (first.failed !== undefined) {
        throw new CdpCallFailedError({ method: `Page.navigate to ${url}`, detail: first.failed });
      }
      const fired = first.fired ?? (await loaded);
      // A same-document load may have fired before the waiter existed; the document is asked.
      if (!fired && (await evaluate('document.readyState')) !== 'complete') {
        throw new CdpTimeoutError({ method: `Page.navigate to ${url}`, timeoutMs });
      }
      const settled = await evaluate('location.href');
      current = typeof settled === 'string' && settled !== '' ? settled : url;
    },
    waitFor: (selector, options) => ready(selector, options),
    async click(selector, options) {
      // Scrolled into view on every poll: `elementFromPoint` answers nothing off-screen, so an
      // element below the fold would read as covered forever.
      const target = await ready(selector, options, () =>
        evaluate(
          `document.querySelector(${selectorArg(selector)})?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })`,
        ),
      );
      const box = target.box ?? { x: 0, y: 0, width: 0, height: 0 };
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
      const press = { ...at, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...press });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...press });
    },
    async type(selector, text, options) {
      await ready(selector, options);
      await focusOn(selector);
      for (const character of text) {
        for (const frame of characterFrames(character)) await key(frame);
      }
    },
    async focus(selector, options) {
      await ready(selector, options);
      await focusOn(selector);
    },
    async press(chord) {
      // Parsed before a key goes down: a refusal halfway would leave a modifier held.
      const frames = chordFrames(parseKeyChord(chord));
      for (const frame of frames) await key(frame);
    },
    accessibility: (selector, options) =>
      axNodesFor(
        send,
        selector,
        finiteCount('page.accessibility', 'max', options?.max ?? DEFAULT_ACCESSIBILITY_MAX, 1),
      ),
    query,
    evaluate,
    screenshot: (options?: ShotCapture) => capture(send, options ?? {}),
    async colorScheme(scheme: ShotColorScheme) {
      // An EMPTY list is CDP's reset; an explicit `no-preference` would be an override.
      const features =
        scheme === 'no-preference' ? [] : [{ name: 'prefers-color-scheme', value: scheme }];
      await send('Emulation.setEmulatedMedia', { features });
    },
    async prepare(expression) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: expression });
    },
    console: () => watch.console(),
    pageErrors: () => watch.pageErrors(),
    pageErrorsDropped: () => watch.pageErrorsDropped(),
    network: () => watch.network(),
    networkDropped: () => watch.networkDropped(),
  };
}

type Send = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<Readonly<Record<string, unknown>> | undefined>;

/**
 * PNG bytes of the viewport, the whole document, or one clip — never both of the last two, which
 * CDP would resolve silently in favour of one. A clip is CSS pixels in page coordinates.
 */
async function capture(send: Send, framing: ShotCapture): Promise<Uint8Array> {
  const clip = framing.clip;
  assert(
    !(framing.fullPage === true && clip !== undefined),
    'a screenshot was asked for the full page AND a clip, and a capture is one or the other',
    'pass { clip } for one component or { fullPage: true } for the document, never both',
  );
  assert(
    clip === undefined ||
      ([clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) &&
        clip.width > 0 &&
        clip.height > 0),
    'a screenshot clip has no area or is not four finite numbers',
    'pass a clip with a positive width and height: { clip: { x: 0, y: 0, width: 320, height: 200 } }',
  );
  let region = clip;
  if (framing.fullPage === true) {
    const metrics = record((await send('Page.getLayoutMetrics'))?.['cssContentSize']);
    const width = metrics?.['width'];
    const height = metrics?.['height'];
    if (typeof width === 'number' && typeof height === 'number') {
      region = { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) };
    }
  }
  const answer = await send('Page.captureScreenshot', {
    format: 'png',
    ...(region === undefined ? {} : { clip: { ...region, scale: 1 }, captureBeyondViewport: true }),
  });
  const data = answer?.['data'];
  if (typeof data !== 'string') {
    throw new CdpCallFailedError({
      method: 'Page.captureScreenshot',
      detail: 'the browser answered no image data',
    });
  }
  return Uint8Array.fromBase64(data);
}
