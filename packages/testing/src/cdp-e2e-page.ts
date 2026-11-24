// One responsibility: one TAB over a raw CDP session — navigate, reload, evaluate, click, wait. The
// session (`cdp-e2e-session.ts`) attaches it and owns everything browser-wide: the network
// condition, the init scripts, the socket and request log. Launching is `cdp-launch.ts` and the
// wire is `cdp-connection.ts`.
//
// A handful of methods — and a real finger (`touchDrag`) and key (`press`) — which is why this sits
// next to `@ultimat3/scraping` rather than going through it: `ScrapePage` is a full scraping surface whose intended implementation is
// `puppeteer-core`, and an e2e driver needs none of it.

import type { CdpConnection } from '@ultimat3/scraping/cdp';
import { CdpCallFailedError, CdpTimeoutError } from '@ultimat3/scraping/cdp';
import type { AxTreeNode } from './ax-node';
import { axRecord, toAxTreeNodes } from './ax-node';
import { registerTabPort } from './cdp-ports';
import type { AxTreeRequest, E2eBrowserPage } from './e2e-page';

/** What the page threw, when `Runtime.evaluate` answered with an exception rather than a value. */
const thrownIn = (result: Record<string, unknown> | undefined): string | undefined => {
  const thrown = result?.['exceptionDetails'];
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  const text = (thrown as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : 'the expression threw in the page';
};

/** `Runtime.evaluate`'s answer, unwrapped. Every field here is somebody else's JSON. */
const evaluated = (result: Record<string, unknown> | undefined): unknown => {
  const threw = thrownIn(result);
  if (threw !== undefined) {
    throw new CdpCallFailedError({ method: 'Runtime.evaluate', detail: threw });
  }
  const remote = result?.['result'];
  if (typeof remote !== 'object' || remote === null) return undefined;
  return (remote as Record<string, unknown>)['value'];
};

/**
 * What Chrome answers a `Runtime.evaluate` that was in flight when the document committed (#774):
 * the call is refused at the protocol level, not thrown in the page. The same first text is also
 * what a CLOSED tab answers, which is why `waitFor` asks for the target before it polls again.
 */
const NAVIGATED_AWAY = [
  'Inspected target navigated or closed',
  'Execution context was destroyed',
  'Cannot find context with specified id',
  // A tree node's DOM id from the document that was just replaced (`DOM.resolveNode`).
  'No node with given id found',
] as const;

/** A call refused because the document it addressed is gone: "not this document", not a failure. */
export const navigatedAway = (error: unknown): error is CdpCallFailedError =>
  error instanceof CdpCallFailedError && NAVIGATED_AWAY.some((text) => error.cause.includes(text));

/** One tab: the port the driver drives, plus what a multi-tab acceptance suite asks of one. */
export interface E2eTab extends E2eBrowserPage {
  readonly targetId: string;
  /** Browser-wide, like the switch it models: every tab AND every worker goes with it. */
  offline(enabled: boolean): Promise<void>;
  /**
   * THIS tab's scripting, off or back on (`Emulation.setScriptExecutionDisabled`): the page's own
   * scripts stop. What proves a page works with no JS — a link that only a script could follow is
   * a page that fails for every visitor whose JS did not load. Takes effect from the next document.
   * Off, `evaluate` still answers a SYNCHRONOUS expression and `click` still clicks, but no page
   * callback runs — so `goto`, which waits on the page's `load` listener, never settles: navigate
   * with `evaluate('location.href = …')` and poll with `waitFor`.
   */
  scripting(enabled: boolean): Promise<void>;
  /**
   * A REAL click: the pointer moved to the element's centre, pressed and released through
   * `Input.dispatchMouseEvent`, so the browser hit-tests it as it would a person's — and anything
   * painted over the element (a view transition's overlay, a modal) receives it instead. `click()`
   * dispatches straight at the element and can never see that.
   */
  pointerClick(selector: string): Promise<void>;
  /**
   * A REAL finger (`Input.dispatchTouchEvent`, touch emulation on for the tab the first time): a
   * start at `from`, `steps` moves to `to`, an end, in viewport CSS px. Trusted input, so the
   * browser hit-tests it, honours `touch-action`, and may take it for a scroll and send
   * `pointercancel` — what a page-dispatched touch PointerEvent can never show (no active pointer).
   */
  touchDrag(from: TouchPoint, to: TouchPoint, steps?: number): Promise<void>;
  /**
   * A REAL key press (`Input.dispatchKeyEvent`, down then up) at whatever has focus, so its default
   * action runs: Tab moves focus, which a dispatched `KeyboardEvent` never does. A name in
   * `PRESS_KEYS` or one printable character.
   */
  press(key: string): Promise<void>;
  /** Required on a tab: the audit of every `e2eTest` reads it (`e2e-a11y-run.ts`). */
  accessibilityTree(request: AxTreeRequest): Promise<readonly AxTreeNode[]>;
  /** Reload and wait for the load, at the url the tab already had. */
  reload(): Promise<void>;
  /** Poll `expression` in the page until it is truthy, or refuse naming `what`. */
  waitFor(expression: string, what: string, timeoutMs?: number): Promise<void>;
  /** The IndexedDB databases this tab's origin holds, by name, sorted. */
  indexedDbNames(): Promise<readonly string[]>;
  close(): Promise<void>;
}

/** A viewport point in CSS px, as `getBoundingClientRect()` answers it. */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** Named keys `press()` knows, with the Windows virtual key code Chrome routes them by. */
export const PRESS_KEYS: Readonly<Record<string, number>> = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Backspace: 8,
  Delete: 46,
};

/** The key code of a printable character: its upper-case code point for a letter or digit. */
const charCode = (key: string): number | undefined =>
  key.length === 1 && /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined;

/**
 * The text a key TYPES, as puppeteer's key table has it. A key with text goes down as `keyDown`
 * carrying it, so Chrome raises the character event — what makes Enter submit a focused button's
 * form. A key with none (Tab, the arrows) goes down as `rawKeyDown`.
 */
const typedText = (key: string): string | undefined =>
  key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;

/** `KeyboardEvent.code`: `KeyA`, `Digit7`, `Space`; a named key is its own code. */
const keyCodeName = (key: string): string =>
  key === ' '
    ? 'Space'
    : /^[a-z]$/i.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key;

export interface CdpE2eTabOptions {
  readonly connection: CdpConnection;
  /** The attached tab's flattened session — every page call carries it. */
  readonly sessionId: string;
  readonly targetId: string;
  /**
   * How long a navigation's load event may take. Distinct from the connection's per-call deadline:
   * `Page.navigate` ANSWERS as soon as the navigation is committed, so the wait for the load event
   * is a second budget and is the one an app makes long.
   */
  readonly loadTimeoutMs: number;
  /** The session's browser-wide switch, which `offline()` forwards to. */
  readonly offline: (enabled: boolean) => Promise<void>;
  /**
   * The raw-tab accessibility audit (`e2e-a11y-tabs.ts`), which the session wires: `navigated`
   * after every settled `goto`/`reload`, `used` on every call the tab sends, `closed` once
   * `close()` is answered. Absent, a tab is a
   * bare driver — what this file's own unit tests build.
   */
  readonly audit?: { navigated(): Promise<void>; used(): void; closed(): void } | undefined;
}

const POLL_MS = 100;

/** The one place the framework reads a whole document's accessibility tree. */
export const FULL_AX_TREE = 'Accessibility.getFullAXTree';

/**
 * Run ON the resolved node: a document answers for its `<html>`, opening tag only — its whole
 * markup starts with the head, which names nothing. Bounded as `e2e-a11y.ts` says.
 */
const DESCRIBE_NODE = `function (selectors) {
  const el = this.nodeType === 9 ? this.documentElement : this;
  if (!el || typeof el.outerHTML !== 'string') return JSON.stringify({ html: '', matches: [] });
  const html = el === document.documentElement ? el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1) : el.outerHTML;
  return JSON.stringify({
    html: html.slice(0, 120),
    matches: selectors.filter((s) => { try { return el.matches(s); } catch { return false; } }),
  });
}`;

/** A tab over a session the caller has already attached and enabled (`cdp-e2e-session.ts`). */
export function cdpE2eTab(options: CdpE2eTabOptions): E2eTab {
  const sendRaw = options.connection.send.bind(options.connection);
  const send: CdpConnection['send'] = (...args) => {
    options.audit?.used();
    return sendRaw(...args);
  };
  const { sessionId } = options;

  // `url()` is SYNCHRONOUS on the port, and CDP has no synchronous read — so the last committed
  // url is tracked here. Seeded with the tab's own starting url rather than '' so a `reload()`
  // before any `goto()` navigates somewhere real.
  let current = 'about:blank';
  // Touch emulation is per tab and stays on: switched on by the first `touchDrag`, once.
  let touchOn = false;

  const evaluateRaw = (expression: string) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  const evaluate = async (expression: string): Promise<unknown> =>
    evaluated((await evaluateRaw(expression)).result);

  // A poll that THROWS is a poll that does not hold yet, not a refusal: a click that navigates
  // leaves the next poll reading a document whose `<body>` is not parsed, and
  // `document.body.textContent` throws there once and holds a poll later. The last throw is kept
  // and named at the deadline, so an expression that can never evaluate still says why.
  //
  // A poll the browser REFUSED because the document committed under it is the same "not yet"
  // (#774) — but only while the tab is still there: a closed tab answers with the same text, and
  // still refuses at once. Any other refusal (a dead connection) refuses at once too.
  const tabOpen = (): Promise<boolean> =>
    send('Target.getTargetInfo', { targetId: options.targetId }).then(
      () => true,
      () => false,
    );
  const poll = async (expression: string): Promise<Record<string, unknown> | 'navigated'> => {
    try {
      return (await evaluateRaw(`Boolean(${expression})`)).result ?? {};
    } catch (error) {
      if (navigatedAway(error) && (await tabOpen())) return 'navigated';
      throw error;
    }
  };
  const waitFor = async (expression: string, what: string, timeoutMs = options.loadTimeoutMs) => {
    // Only the PAGE's throw is swallowed: a connection that died still refuses at once.
    let threw: string | undefined;
    for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
      const answer = await poll(expression);
      if (answer === 'navigated') {
        threw = 'the document committed while the poll was in flight';
        await Bun.sleep(POLL_MS);
        continue;
      }
      threw = thrownIn(answer);
      if (threw === undefined && evaluated(answer) === true) return;
      await Bun.sleep(POLL_MS);
    }
    const last = threw === undefined ? '' : `, and its last poll threw: ${threw}`;
    throw new CdpTimeoutError({ method: `waitFor(${what})${last}`, timeoutMs });
  };

  // One node described: resolved to a page object, asked in the page, released with its group.
  const describeNode = async (
    backendNodeId: number,
    selectors: readonly string[],
  ): Promise<Pick<AxTreeNode, 'html' | 'matches'>> => {
    const objectGroup = 'x-e2e-a11y';
    const resolved = await send('DOM.resolveNode', { backendNodeId, objectGroup }, sessionId);
    const objectId = axRecord(resolved.result?.['object'])?.['objectId'];
    if (typeof objectId !== 'string') return {};
    try {
      const raw = evaluated(
        (
          await send(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: DESCRIBE_NODE,
              arguments: [{ value: selectors }],
              returnByValue: true,
            },
            sessionId,
          )
        ).result,
      );
      const answer = axRecord(typeof raw === 'string' ? JSON.parse(raw) : raw);
      const html = answer?.['html'];
      const matches = answer?.['matches'];
      return {
        ...(typeof html === 'string' ? { html } : {}),
        matches: Array.isArray(matches)
          ? matches.filter((m): m is string => typeof m === 'string')
          : [],
      };
    } finally {
      await send('Runtime.releaseObjectGroup', { objectGroup }, sessionId).catch(() => undefined);
    }
  };

  const tab: E2eTab = {
    targetId: options.targetId,
    url: () => current,
    async goto(url: string): Promise<unknown> {
      // **The load EVENT is the signal, not the reply.** Chrome drops `Page.navigate`'s own reply
      // whenever the navigation swaps the render process — measured on Chrome 150 against a local
      // server: the page loads, the server is hit, a later `Runtime.evaluate` answers `document
      // .title` from the new document, and the navigate frame never comes back at all. Awaiting
      // the reply therefore waited out the full deadline on the most ordinary navigation there is,
      // `about:blank` → `http://localhost:<port>/`. So the waiter is registered BEFORE the send,
      // and the reply is raced against it rather than depended on.
      const loaded = options.connection.once(
        'Page.loadEventFired',
        sessionId,
        options.loadTimeoutMs,
      );
      // A dropped reply is expected, so its rejection is answered rather than thrown: what the
      // reply is still worth reading for is `errorText`, which is the ONLY place a refused
      // navigation is named — an unreachable host loads no page and fires no load event.
      const answered = send('Page.navigate', { url }, sessionId).then(
        (answer) => {
          const failed = answer.result?.['errorText'];
          return typeof failed === 'string' && failed !== '' ? failed : undefined;
        },
        () => undefined,
      );
      const failed = await Promise.race([loaded.then(() => undefined), answered]);
      if (failed !== undefined) {
        throw new CdpCallFailedError({ method: `Page.navigate to ${url}`, detail: failed });
      }
      current = url;
      // The load event may already have fired before the waiter was registered on a same-process
      // navigation, and `answered` can win the race on one too. So the document is asked directly:
      // a `readyState` that is already `complete` resolves at once, and the deadline resolves
      // rather than throwing — a slow page is the app's business, and the assertion after this is
      // what should fail. HALF the budget, because the budget is also the connection's per-call
      // deadline: a page timer of the full budget raced that deadline and lost, reporting a page
      // that never fired `load` as "Runtime.evaluate did not answer" instead.
      await evaluate(`(() => new Promise((resolve) => {
        if (document.readyState === 'complete') { resolve(true); return; }
        const done = () => resolve(true);
        addEventListener('load', done, { once: true });
        setTimeout(done, ${String(Math.floor(options.loadTimeoutMs / 2))});
      }))()`);
      // The app may have redirected, so the committed url is re-read rather than assumed.
      const settled = await evaluate('location.href');
      if (typeof settled === 'string' && settled !== '') current = settled;
      // The document as it settled, before anything replaces it: what a person would land on.
      await options.audit?.navigated();
      return undefined;
    },
    evaluate,
    async click(selector: string): Promise<void> {
      // In-page rather than a synthesised `Input.dispatchMouseEvent`: the port takes a SELECTOR,
      // and turning one into coordinates means a box model read, a scroll and a hit test — three
      // more CDP calls, each with its own way to be wrong about an element the page can click.
      const clicked = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (clicked !== true) {
        throw new CdpCallFailedError({
          method: `click(${selector})`,
          detail: 'no element in the page matches that selector',
        });
      }
    },
    async pointerClick(selector: string): Promise<void> {
      const at = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
      );
      if (!Array.isArray(at) || typeof at[0] !== 'number' || typeof at[1] !== 'number') {
        throw new CdpCallFailedError({
          method: `pointerClick(${selector})`,
          detail: 'no element in the page matches that selector',
        });
      }
      const [x, y] = at;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
        const pressed = type !== 'mouseMoved';
        await send(
          'Input.dispatchMouseEvent',
          { type, x, y, button: pressed ? 'left' : 'none', clickCount: pressed ? 1 : 0 },
          sessionId,
        );
      }
    },
    async touchDrag(from: TouchPoint, to: TouchPoint, steps = 5): Promise<void> {
      if (!Number.isInteger(steps) || steps < 1) {
        throw new CdpCallFailedError({
          method: `touchDrag(steps: ${String(steps)})`,
          detail: 'steps is the number of moves, a whole number of at least 1',
        });
      }
      if (!touchOn) {
        await send(
          'Emulation.setTouchEmulationEnabled',
          { enabled: true, maxTouchPoints: 1 },
          sessionId,
        );
        touchOn = true;
      }
      const touch = (type: string, points: readonly TouchPoint[]) =>
        send(
          'Input.dispatchTouchEvent',
          { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y })) },
          sessionId,
        );
      await touch('touchStart', [from]);
      for (let step = 1; step <= steps; step += 1) {
        const at = (a: number, b: number): number => a + ((b - a) * step) / steps;
        await touch('touchMove', [{ x: at(from.x, to.x), y: at(from.y, to.y) }]);
      }
      await touch('touchEnd', []);
    },
    async press(key: string): Promise<void> {
      const code = (Object.hasOwn(PRESS_KEYS, key) ? PRESS_KEYS[key] : undefined) ?? charCode(key);
      if (code === undefined) {
        throw new CdpCallFailedError({
          method: `press(${key})`,
          detail: `not a key press() knows: one of ${Object.keys(PRESS_KEYS).join(', ')}, or one letter or digit`,
        });
      }
      const text = typedText(key);
      const common = { key, code: keyCodeName(key), windowsVirtualKeyCode: code };
      await send(
        'Input.dispatchKeyEvent',
        {
          type: text === undefined ? 'rawKeyDown' : 'keyDown',
          ...common,
          ...(text === undefined ? {} : { text }),
        },
        sessionId,
      );
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sessionId);
    },
    offline: (enabled: boolean) => options.offline(enabled),
    async accessibilityTree(request: AxTreeRequest): Promise<readonly AxTreeNode[]> {
      const nodes = toAxTreeNodes((await send(FULL_AX_TREE, {}, sessionId)).result);
      const out: AxTreeNode[] = [];
      for (const node of nodes) {
        const described =
          node.backendNodeId !== undefined && request.describe(node)
            ? await describeNode(node.backendNodeId, request.selectors)
            : {};
        out.push({ ...node, ...described });
      }
      return out;
    },
    async scripting(enabled: boolean): Promise<void> {
      await send('Emulation.setScriptExecutionDisabled', { value: !enabled }, sessionId);
    },
    async reload(): Promise<void> {
      const at = current;
      // Reload is a navigation to the url the tab already has — the one wait the port proves.
      await tab.goto(at);
    },
    waitFor,
    async indexedDbNames(): Promise<readonly string[]> {
      const names = await evaluate(
        '(async () => (await indexedDB.databases()).map((db) => db.name ?? "").sort())()',
      );
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === 'string')
        : [];
    },
    async close(): Promise<void> {
      await send('Target.closeTarget', { targetId: options.targetId });
      options.audit?.closed();
    },
  };
  // What `addVirtualAuthenticator(tab)` drives: this tab's own session, never a member on the port.
  registerTabPort(tab, { connection: options.connection, sessionId });
  return tab;
}
