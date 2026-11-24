// One tab's console over a raw CDP session: every `Runtime.consoleAPICalled` and
// `Runtime.exceptionThrown` its session sends, from the moment the tab is built until it closes.
// The session enables `Runtime` before the tab is handed out (`cdp-e2e-session.ts`).

import type { CdpConnection } from '@ultimat3/scraping/cdp';
import type { E2eConsoleLevel, E2eConsoleMessage } from './e2e-console';

export interface ConsoleCapture {
  messages(): readonly E2eConsoleMessage[];
  stop(): void;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** A `Runtime.RemoteObject` as the console prints it: a primitive's value, else its description. */
const shown = (arg: unknown): string => {
  const remote = record(arg);
  const value = remote?.['value'];
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value);
  const described = remote?.['description'] ?? remote?.['unserializableValue'] ?? remote?.['type'];
  return typeof described === 'string' ? described : '';
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
  const messages: E2eConsoleMessage[] = [];
  const offCall = connection.on('Runtime.consoleAPICalled', (params, on) => {
    if (on !== sessionId) return;
    const args = Array.isArray(params['args']) ? params['args'] : [];
    messages.push({
      level: levelOf(params['type']),
      text: args.map(shown).join(' '),
      source: 'console',
    });
  });
  const offThrow = connection.on('Runtime.exceptionThrown', (params, on) => {
    if (on !== sessionId) return;
    const details = record(params['exceptionDetails']);
    const described = record(details?.['exception'])?.['description'];
    const text = typeof described === 'string' ? described : details?.['text'];
    messages.push({
      level: 'error',
      text: typeof text === 'string' ? text : 'an uncaught exception',
      source: 'exception',
    });
  });
  return {
    messages: () => [...messages],
    stop: () => {
      offCall();
      offThrow();
    },
  };
}
