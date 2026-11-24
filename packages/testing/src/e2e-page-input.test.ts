// `pressKey`, `consoleMessages` and `expectNoConsoleErrors` over the page an e2e test holds: each
// forwards to the browser port behind it, refuses by name when that port cannot, and the console
// reads only what arrived since the running test began.

import { describe, expect, test } from 'bun:test';
import type { E2eConsoleMessage } from './e2e-console';
import type { E2eBrowserPage } from './e2e-page';
import { e2ePage } from './e2e-page';
import {
  consoleMessages,
  expectNoConsoleErrors,
  markConsoleStart,
  pressKey,
} from './e2e-page-input';
import type { PageLike } from './test-types';

/** A port with both members, or without the one `missing` names, as a hand-rolled port may be. */
const portWith = (missing?: 'press' | 'consoleMessages') => {
  const pressed: string[] = [];
  const evaluated: string[] = [];
  const messages: E2eConsoleMessage[] = [];
  // What the browser sends before it answers the NEXT evaluate: in flight until that round trip.
  const inFlight: E2eConsoleMessage[] = [];
  const port: E2eBrowserPage = {
    url: () => 'http://127.0.0.1:3000/',
    goto: () => Promise.resolve(undefined),
    evaluate: async (expression) => {
      evaluated.push(expression);
      await Promise.resolve();
      messages.push(...inFlight.splice(0));
      return undefined;
    },
    click: () => Promise.resolve(),
    press: (key) => {
      pressed.push(key);
      return Promise.resolve();
    },
    consoleMessages: () => [...messages],
    clearConsole: () => {
      messages.length = 0;
    },
  };
  if (missing !== undefined) delete port[missing];
  const page = e2ePage({ page: port, baseUrl: 'http://127.0.0.1:3000' });
  return { page, pressed, evaluated, messages, inFlight };
};

const codeOf = async (work: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await work();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('the call answered');
};

describe('pressKey', () => {
  test('forwards the key or chord to the port', async () => {
    const { page, pressed } = portWith();
    await pressKey(page, 'Tab');
    await pressKey(page, 'Control+k');
    expect(pressed).toEqual(['Tab', 'Control+k']);
  });

  test('a port with no press(), or a page no e2e driver built, refuses by name', async () => {
    const { page } = portWith('press');
    expect(await codeOf(() => pressKey(page, 'Tab'))).toBe('X_TEST_FIXTURE_UNAVAILABLE');
    const stranger = { url: () => '/' } as unknown as PageLike;
    expect(await codeOf(() => pressKey(stranger, 'Tab'))).toBe('X_TEST_FIXTURE_UNAVAILABLE');
  });
});

describe('consoleMessages', () => {
  test('answers what arrived since the test began, after one round trip to the page', async () => {
    const { page, messages, inFlight, evaluated } = portWith();
    messages.push({ level: 'error', text: 'an earlier test', source: 'console' });
    // Printed by the earlier test, still in flight as this one starts: the start flushes it first.
    inFlight.push({ level: 'error', text: 'an earlier test, late', source: 'console' });
    await markConsoleStart(page);
    // Printed by this test just before the read: only the read's round trip brings it in.
    inFlight.push({ level: 'log', text: 'hello', source: 'console' });
    expect(await consoleMessages(page)).toEqual([
      { level: 'log', text: 'hello', source: 'console' },
    ]);
    expect(evaluated).toHaveLength(2);
  });

  test('a port with no consoleMessages() refuses by name', async () => {
    const { page } = portWith('consoleMessages');
    expect(await codeOf(() => consoleMessages(page))).toBe('X_TEST_FIXTURE_UNAVAILABLE');
  });
});

describe('expectNoConsoleErrors', () => {
  test('passes on logs and warnings', async () => {
    const { page, messages } = portWith();
    messages.push({ level: 'warning', text: 'deprecated', source: 'console' });
    await expectNoConsoleErrors(page);
  });

  test('refuses with every error, console and uncaught alike', async () => {
    const { page, inFlight } = portWith();
    inFlight.push(
      { level: 'error', text: 'failed to load', source: 'console' },
      { level: 'log', text: 'fine', source: 'console' },
      { level: 'error', text: 'TypeError: x is null', source: 'exception' },
    );
    const thrown = await expectNoConsoleErrors(page).catch((error: unknown) => error);
    expect((thrown as { code?: string }).code).toBe('X_E2E_CONSOLE_ERRORS');
    const cause = String((thrown as { cause?: unknown }).cause);
    expect(cause).toContain('failed to load');
    expect(cause).toContain('TypeError: x is null');
    expect(cause).not.toContain('fine');
  });
});
