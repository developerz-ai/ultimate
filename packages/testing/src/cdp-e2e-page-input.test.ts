// A tab's keyboard chords and its console, over a fake connection: the exact `Input.dispatchKeyEvent`
// a chord sends, and which `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` events the tab
// keeps — its own session's, from the moment it was built, until it is closed.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener, CdpResult } from '@ultimat3/scraping/cdp';
import { CONSOLE_KEEP, CONSOLE_LINE_CHARS } from './cdp-console-capture';
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
    expect(keyEvents(calls)).toEqual([
      ['rawKeyDown', 'k', 2, undefined],
      ['keyUp', 'k', 2, undefined],
      ['rawKeyDown', 'Tab', 8, undefined],
      ['keyUp', 'Tab', 8, undefined],
      ['rawKeyDown', 'Enter', 12, undefined],
      ['keyUp', 'Enter', 12, undefined],
    ]);
  });

  test('Shift makes the key a US keyboard makes, typed or not; the code stays physical', async () => {
    const { connection, calls } = fakeConnection();
    const tab = tabOn(connection);
    await tab.press('Shift+a');
    await tab.press('Control+Shift+k');
    await tab.press('Shift+1');
    const downs = calls
      .filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params['type'] !== 'keyUp')
      .map((call) => [
        call.params['key'],
        call.params['code'],
        call.params['windowsVirtualKeyCode'],
        call.params['modifiers'],
        call.params['text'],
      ]);
    expect(downs).toEqual([
      ['A', 'KeyA', 65, 8, 'A'],
      ['K', 'KeyK', 75, 10, undefined],
      ['!', 'Digit1', 49, 8, '!'],
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

  test('a chord the grammar refuses, or a key press() does not know, refuses by name', async () => {
    const { connection } = fakeConnection();
    const tab = tabOn(connection);
    const codes: unknown[] = [];
    for (const chord of ['Hyper+k', 'Control+', '+', 'Control+Hyper', 'é']) {
      codes.push(
        ((await tab.press(chord).catch((error: unknown) => error)) as { code?: string }).code,
      );
    }
    expect(codes).toEqual([
      'X_SCRAPE_KEY_INVALID',
      'X_SCRAPE_KEY_INVALID',
      'X_SCRAPE_KEY_INVALID',
      'X_CDP_CALL_FAILED',
      'X_CDP_CALL_FAILED',
    ]);
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
    emit('Runtime.consoleAPICalled', { type: 'assert', args: [{ value: 'held' }] }, 'session-1');
    emit(
      'Runtime.exceptionThrown',
      {
        exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is null' } },
      },
      'session-1',
    );
    emit(
      'Runtime.exceptionThrown',
      { exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: 'broken' } } },
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
      { level: 'error', text: 'held', source: 'console' },
      { level: 'error', text: 'TypeError: x is null', source: 'exception' },
      { level: 'error', text: 'broken', source: 'exception' },
      { level: 'log', text: 'Object', source: 'console' },
    ]);
  });

  test('a cross-site frame attached under the tab is heard; an unrelated session is not', () => {
    const { connection, emit } = fakeConnection();
    const tab = tabOn(connection);
    const frameError = { type: 'error', args: [{ value: 'frame broke' }] };
    emit('Runtime.consoleAPICalled', frameError, 'frame-1');
    emit(
      'Target.attachedToTarget',
      { sessionId: 'frame-1', targetInfo: { type: 'iframe' } },
      'session-1',
    );
    emit(
      'Target.attachedToTarget',
      { sessionId: 'frame-2', targetInfo: { type: 'iframe' } },
      'session-2',
    );
    emit('Runtime.consoleAPICalled', frameError, 'frame-1');
    emit('Runtime.consoleAPICalled', frameError, 'frame-2');
    emit('Target.detachedFromTarget', { sessionId: 'frame-1' }, 'session-1');
    emit('Runtime.consoleAPICalled', frameError, 'frame-1');
    expect(tab.consoleMessages?.()).toEqual([
      { level: 'error', text: 'frame broke', source: 'console' },
    ]);
  });

  test('clear forgets what was held; the capture keeps the newest CONSOLE_KEEP lines', () => {
    const { connection, emit } = fakeConnection();
    const tab = tabOn(connection);
    const line = (n: number) =>
      emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: String(n) }] }, 'session-1');
    line(0);
    tab.clearConsole?.();
    expect(tab.consoleMessages?.()).toEqual([]);
    for (let n = 1; n <= CONSOLE_KEEP + 5; n += 1) line(n);
    const kept = tab.consoleMessages?.() ?? [];
    expect(kept).toHaveLength(CONSOLE_KEEP);
    expect(kept[0]?.text).toBe('6');
  });

  test('past the bound an error outlives the noise, and a huge line is clipped', () => {
    const { connection, emit } = fakeConnection();
    const tab = tabOn(connection);
    emit(
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ value: 'x'.repeat(5_000) }] },
      'session-1',
    );
    for (let n = 0; n < CONSOLE_KEEP * 2; n += 1) {
      emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: String(n) }] }, 'session-1');
    }
    const kept = tab.consoleMessages?.() ?? [];
    expect(kept).toHaveLength(CONSOLE_KEEP);
    expect(kept[0]?.level).toBe('error');
    expect(kept[0]?.text).toHaveLength(CONSOLE_LINE_CHARS + 1);
  });

  test('close stops listening', async () => {
    const { connection, listening } = fakeConnection();
    const tab = tabOn(connection);
    expect(listening('Runtime.consoleAPICalled')).toBe(1);
    await tab.close();
    for (const event of [
      'Runtime.consoleAPICalled',
      'Runtime.exceptionThrown',
      'Target.attachedToTarget',
      'Target.detachedFromTarget',
    ]) {
      expect(listening(event)).toBe(0);
    }
  });
});
