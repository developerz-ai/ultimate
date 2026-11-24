// One tab's console over a raw CDP session: every `Runtime.consoleAPICalled` and
// `Runtime.exceptionThrown` its session, or a cross-site frame attached under it, sends — kept
// since the last `clear()`, bounded in lines and in characters per line, until the tab closes.

import type { CdpConnection } from '@ultimat3/scraping/cdp';
import type { E2eConsoleLevel, E2eConsoleMessage } from './e2e-console';

/** The most lines one capture holds: a tab nobody clears logs for a whole suite. */
export const CONSOLE_KEEP = 1_000;

/** The most characters one line keeps, so the bound above is a bound on memory too. */
export const CONSOLE_LINE_CHARS = 2_000;

const clipped = (text: string): string =>
  text.length > CONSOLE_LINE_CHARS ? `${text.slice(0, CONSOLE_LINE_CHARS)}…` : text;

export interface ConsoleCapture {
  messages(): readonly E2eConsoleMessage[];
  /** Forget everything held so far. Constant time. */
  clear(): void;
  stop(): void;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * A `Runtime.RemoteObject` as its raw argument: a primitive's value, else its description. No
 * format substitution — `console.log('n: %d', 2)` is `n: %d 2`, not what DevTools prints.
 */
const shown = (arg: unknown): string | undefined => {
  const remote = record(arg);
  const value = remote?.['value'];
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value);
  const described = remote?.['description'] ?? remote?.['unserializableValue'] ?? remote?.['type'];
  return typeof described === 'string' ? described : undefined;
};

/** Chrome's `consoleAPICalled.type` folded onto the five levels a console filter shows. */
const levelOf = (type: unknown): E2eConsoleLevel => {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  if (type === 'info') return 'info';
  if (type === 'debug') return 'debug';
  return 'log';
};

export function captureConsole(connection: CdpConnection, sessionId: string): ConsoleCapture {
  let messages: E2eConsoleMessage[] = [];
  // The tab's own session and the out-of-process frames attached under it: a cross-site iframe
  // reports its console on its own session, and its errors are this page's errors.
  const sessions = new Set([sessionId]);
  // Past the bound the oldest NON-error goes first, so an error is never what makes room while
  // anything else is held: `expectNoConsoleErrors` keeps its verdict on a noisy page.
  const keep = (message: E2eConsoleMessage): void => {
    messages.push({ ...message, text: clipped(message.text) });
    if (messages.length <= CONSOLE_KEEP) return;
    const quieter = messages.findIndex((held) => held.level !== 'error');
    messages.splice(quieter === -1 ? 0 : quieter, 1);
  };
  const offs = [
    connection.on('Target.attachedToTarget', (params, on) => {
      const child = params['sessionId'];
      const type = record(params['targetInfo'])?.['type'];
      if (on !== undefined && sessions.has(on) && type === 'iframe' && typeof child === 'string') {
        sessions.add(child);
      }
    }),
    connection.on('Target.detachedFromTarget', (params, on) => {
      const child = params['sessionId'];
      if (
        on !== undefined &&
        sessions.has(on) &&
        child !== sessionId &&
        typeof child === 'string'
      ) {
        sessions.delete(child);
      }
    }),
    connection.on('Runtime.consoleAPICalled', (params, on) => {
      if (on === undefined || !sessions.has(on)) return;
      const args = Array.isArray(params['args']) ? params['args'] : [];
      keep({
        level: levelOf(params['type']),
        text: args.map((arg) => shown(arg) ?? '').join(' '),
        source: 'console',
      });
    }),
    connection.on('Runtime.exceptionThrown', (params, on) => {
      if (on === undefined || !sessions.has(on)) return;
      const details = record(params['exceptionDetails']);
      // `throw 'broken'` carries its payload as the exception's value, with no description.
      const thrown = shown(details?.['exception']);
      const label = details?.['text'];
      keep({
        level: 'error',
        text: thrown ?? (typeof label === 'string' ? label : 'an uncaught exception'),
        source: 'exception',
      });
    }),
  ];
  return {
    messages: () => [...messages],
    clear: () => {
      messages = [];
    },
    stop: () => {
      for (const off of offs) off();
    },
  };
}
