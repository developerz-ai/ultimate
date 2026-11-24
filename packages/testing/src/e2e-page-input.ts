// Key presses and the console, for the page an e2e test holds. Free functions over `PageLike`
// rather than members of it, so no implementation of that interface has to grow: each reaches the
// browser port `e2ePage()` was built over, and refuses by name when that port cannot.

import type { E2eConsoleMessage } from './e2e-console';
import { E2eConsoleErrorsError } from './e2e-errors';
import type { E2eBrowserPage } from './e2e-page';
import { FixtureUnavailableError } from './errors';
import type { PageLike } from './test-types';

interface Binding {
  readonly port: E2eBrowserPage;
  /** Where the running test's console starts in the port's whole log. */
  from: number;
}

/** A WeakMap, so a page nobody holds any more is not kept alive by having been bound. */
const bindings = new WeakMap<PageLike, Binding>();

const DRIVER_PAGE = "the page e2eTest or a test's `{ page }` fixture hands you";

/** Called by `e2ePage()`: the page it answers, and the port behind it. */
export function bindPagePort(page: PageLike, port: E2eBrowserPage): void {
  bindings.set(page, { port, from: port.consoleMessages?.().length ?? 0 });
}

const portOf = (page: PageLike, call: string, member: string): E2eBrowserPage => {
  const binding = bindings.get(page);
  if (binding === undefined) throw new FixtureUnavailableError({ name: call, needs: DRIVER_PAGE });
  if (binding.port[member as keyof E2eBrowserPage] === undefined) {
    throw new FixtureUnavailableError({
      name: call,
      needs: `a page whose driver implements ${member}() — cdpE2eTab does; a hand-rolled E2eBrowserPage may not`,
    });
  }
  return binding.port;
};

/**
 * A REAL key press at whatever has focus, so its default action runs (Tab moves focus, Enter
 * submits): a key name (`Tab`, `Enter`, `Escape`, the arrows …), one letter or digit, or a chord
 * with modifiers held (`Shift+Tab`, `Control+k`, `Meta+Shift+Enter`).
 */
export async function pressKey(page: PageLike, key: string): Promise<void> {
  const port = portOf(page, 'pressKey', 'press');
  await port.press?.(key);
}

/** Marks where the running test's console begins: the e2e driver calls it as each test starts. */
export function markConsoleStart(page: PageLike): void {
  const binding = bindings.get(page);
  if (binding === undefined) return;
  binding.from = binding.port.consoleMessages?.().length ?? 0;
}

/**
 * Every console line and uncaught exception since the running test began. One round trip to the
 * page first: the browser sends each console event before the reply to a later call, so a line
 * printed just before this call is in the answer.
 */
export async function consoleMessages(page: PageLike): Promise<readonly E2eConsoleMessage[]> {
  const port = portOf(page, 'consoleMessages', 'consoleMessages');
  await port.evaluate('0');
  return (port.consoleMessages?.() ?? []).slice(bindings.get(page)?.from ?? 0);
}

/**
 * Refuses with `X_E2E_CONSOLE_ERRORS`, quoting each, when the page printed `console.error` (or a
 * failed `console.assert`) or threw an uncaught exception since the running test began. Warnings
 * and logs pass; filter `consoleMessages(page)` for a stricter or looser rule.
 */
export async function expectNoConsoleErrors(page: PageLike): Promise<void> {
  const errors = (await consoleMessages(page)).filter((message) => message.level === 'error');
  if (errors.length === 0) return;
  throw new E2eConsoleErrorsError({
    errors: errors.map((message) => message.text),
    url: page.url(),
  });
}
