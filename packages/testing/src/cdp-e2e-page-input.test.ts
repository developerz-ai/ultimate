// A tab's keyboard chords and its console, over a fake connection: the exact `Input.dispatchKeyEvent`
// a chord sends, and which `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` events the tab
// keeps — its own session's, from the moment it was built, until it is closed.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener, CdpResult } from '@ultimat3/scraping/cdp';
import { cdpE2eTab } from './cdp-e2e-page';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const fakeConnection = () => {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<CdpEventListener>>();
  const connection: CdpConnection = {
    send(method, params = {}): Promise<CdpResult> {
      calls.push({ method, params });
      return Promise.resolve({ result: {} });
    },
    once: () => Promise.resolve(true),
    on(method, listener) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close: () => undefined,
  };
  const emit = (method: string, params: Record<string, unknown>, sessionId: string): void => {
    for (const listener of listeners.get(method) ?? []) listener(params, sessionId);
  };
  return { connection, calls, emit, listening: (method: string) => listeners.get(method)?.size };
};

const tabOn = (connection: CdpConnection) =>
  cdpE2eTab({
    connection,
    sessionId: 'session-1',
    targetId: 'target-1',
    loadTimeoutMs: 100,
    offline: () => Promise.resolve(),
  });

const keyEvents = (calls: readonly Call[]) =>
  calls
    .filter((call) => call.method === 'Input.dispatchKeyEvent')
    .map((call) => [
      call.params['type'],
      call.params['key'],
      call.params['modifiers'],
      call.params['text'],
    ]);

describe('cdpE2eTab · key chords', () => {
  test('a modifier chord sends the modifiers bitmask, and types no text under Control', async () => {
    const { connection, calls } = fakeConnection();
    const tab = tabOn(connection);
    await tab.press('Control+k');
    await tab.press('Shift+Tab');
    await tab.press('Meta+Shift+Enter');
    await tab.press('Shift+a');
    expect(keyEvents(calls)).toEqual([
      ['rawKeyDown', 'k', 2, undefined],
      ['keyUp', 'k', 2, undefined],
      ['rawKeyDown', 'Tab', 8, undefined],
      ['keyUp', 'Tab', 8, undefined],
      ['rawKeyDown', 'Enter', 12, undefined],
      ['keyUp', 'Enter', 12, undefined],
      ['keyDown', 'A', 8, 'A'],
      ['keyUp', 'A', 8, undefined],
    ]);
  });

  test('a key with no modifier sends none, as before', async () => {
    const { connection, calls } = fakeConnection();
    await tabOn(connection).press('Escape');
    expect(keyEvents(calls)).toEqual([
      ['rawKeyDown', 'Escape', undefined, undefined],
      ['keyUp', 'Escape', undefined, undefined],
    ]);
  });

  test('an unknown modifier, or a chord with no key, refuses by name', async () => {
    const { connection } = fakeConnection();
    const tab = tabOn(connection);
    for (const chord of ['Hyper+k', 'Control+', 'Control+Hyper']) {
      const thrown = await tab.press(chord).catch((error: unknown) => error);
      expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    }
  });
});

describe('cdpE2eTab · console', () => {
  test('keeps its own session console calls and uncaught exceptions, in order', () => {
    const { connection, emit } = fakeConnection();
    const tab = tabOn(connection);
    emit(
      'Runtime.consoleAPICalled',
      {
        type: 'error',
        args: [
          { type: 'string', value: 'boom' },
          { type: 'number', value: 2 },
        ],
      },
      'session-1',
    );
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'other tab' }] }, 'session-2');
    emit(
      'Runtime.consoleAPICalled',
      { type: 'warning', args: [{ value: 'careful' }] },
      'session-1',
    );
    emit(
      'Runtime.exceptionThrown',
      {
        exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is null' } },
      },
      'session-1',
    );
    emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'object', description: 'Object' }] },
      'session-1',
    );
    expect(tab.consoleMessages?.()).toEqual([
      { level: 'error', text: 'boom 2', source: 'console' },
      { level: 'warning', text: 'careful', source: 'console' },
      { level: 'error', text: 'TypeError: x is null', source: 'exception' },
      { level: 'log', text: 'Object', source: 'console' },
    ]);
  });

  test('close stops listening', async () => {
    const { connection, listening } = fakeConnection();
    const tab = tabOn(connection);
    expect(listening('Runtime.consoleAPICalled')).toBe(1);
    await tab.close();
    expect(listening('Runtime.consoleAPICalled')).toBe(0);
    expect(listening('Runtime.exceptionThrown')).toBe(0);
  });
});
