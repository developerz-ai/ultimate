// One constructor per way the browser-backed e2e page refuses. Every cause below quotes a value
// that came out of a BROWSER or out of a test's own `toString()`, so every one of them is
// rendered rather than interpolated.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
import type { E2eSelection } from './e2e-selection';
import { selectionCall } from './e2e-selection';

/** A page URL is uncontrolled text; a fix line has to parse after one lands inside it. */
const URL_PLACEHOLDER = '<the url the cause names>';

/**
 * The closure never left the test process. `PageLike.evaluate` takes a function and CDP takes a
 * string, so the only thing that can cross is `Function.prototype.toString()` — and a function
 * with no readable source, or one expecting an argument nothing in the page will pass, has no
 * honest string form at all.
 */
export class E2eEvaluateUnsupportedError extends UltimateError {
  constructor(input: { readonly reason: string; readonly source: string }) {
    super({
      code: 'X_E2E_EVALUATE_UNSUPPORTED',
      cause: `page.evaluate() was given a function that ${input.reason}: ${renderCauseValue(input.source)}`,
      fix: 'page.evaluate(() => document.title)   # a zero-parameter arrow whose body names only page globals',
    });
  }
}

/**
 * The closure crossed and then named something the page has never heard of. This is the failure
 * the whole `evaluate` seam is built around: `const wanted = 3; page.evaluate(() => rows === wanted)`
 * sends the source, so the page receives the NAME `wanted` and a `ReferenceError`. Reported with
 * the binding's own name, because "it threw in the browser" sends the reader to the app.
 */
export class E2eEvaluateCapturedError extends UltimateError {
  constructor(input: { readonly binding: string; readonly source: string }) {
    const binding = renderFixLiteral(input.binding, '<the binding the cause names>');
    super({
      code: 'X_E2E_EVALUATE_CAPTURED',
      cause: `page.evaluate() ran ${renderCauseValue(input.source)} in the browser and ${renderCauseValue(input.binding)} is not defined there — a closure sends its source, never its scope`,
      fix: `page.evaluate(() => document.querySelectorAll("script[src]").length)   # write the value into the closure literally; the page has no binding named ${binding}`,
    });
  }
}

/**
 * The expression ran and the PAGE threw — the app's own failure, not the driver's. Kept apart from
 * the two above so the reader is sent to the app rather than to the test's closure.
 */
export class E2eEvaluateThrewError extends UltimateError {
  constructor(input: { readonly thrown: string; readonly url: string }) {
    super({
      code: 'X_E2E_EVALUATE_THREW',
      cause: `the expression page.evaluate() ran threw inside the browser: ${renderCauseValue(input.thrown)}`,
      fix: `x dev — then open ${renderFixLiteral(input.url, URL_PLACEHOLDER)} and run the same expression in the console; the throw is the page's`,
    });
  }
}

/**
 * Nothing matched. The fix is the retrying assertion and not a longer sleep: `toBeVisible()` looks
 * again to a budget, while `click()` resolves the selection once — so a test that raced the render
 * is asserting in the wrong order rather than waiting for the wrong length of time.
 */
export class E2eLocatorEmptyError extends UltimateError {
  constructor(input: { readonly selection: E2eSelection; readonly url: string }) {
    const call = selectionCall(input.selection);
    super({
      code: 'X_E2E_LOCATOR_EMPTY',
      cause: `${call} matched no element on ${renderCauseValue(input.url)}`,
      fix: `await expect(${call}).toBeVisible() before acting on it — that assertion retries to a budget, click() resolves once`,
    });
  }
}

/**
 * More than one matched and the caller asked to ACT. Never raised by `count()` or `isVisible()`:
 * an assertion handed an ambiguous locator has an answer, and refusing there would turn a question
 * into a crash. A click has no such answer — one of them is about to be pressed.
 */
export class E2eLocatorAmbiguousError extends UltimateError {
  constructor(input: { readonly selection: E2eSelection; readonly count: number }) {
    const call = selectionCall(input.selection);
    super({
      code: 'X_E2E_LOCATOR_AMBIGUOUS',
      cause: `${call} matched ${String(input.count)} elements and click() presses exactly one`,
      fix: `${call}.first().click()   # or narrow the selection until it matches one element`,
    });
  }
}

/**
 * `waitForServiceWorker()` gave up. Bounded IN THE PAGE rather than here: an unbounded wait is a
 * test that hangs, and CI then reports a runner timeout with no assertion anywhere in it.
 */
export class E2eServiceWorkerAbsentError extends UltimateError {
  constructor(input: { readonly url: string; readonly timeoutMs: number }) {
    super({
      code: 'X_E2E_SERVICE_WORKER_ABSENT',
      cause: `no service worker took control of ${renderCauseValue(input.url)} within ${String(input.timeoutMs)}ms`,
      fix: `x build --target static — the worker is generated by the pwa build; then confirm the route at ${renderFixLiteral(input.url, URL_PLACEHOLDER)} registers it`,
    });
  }
}
