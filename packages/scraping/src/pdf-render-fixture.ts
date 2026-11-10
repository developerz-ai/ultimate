// A fake browser for the raw-CDP printer: a connection that answers the calls `pdf-render.ts` makes,
// emits `Fetch.requestPaused` for the document and any subresources the page "loads", and can hold
// the print open so a test can watch the concurrency bound and an abort. No Chrome.

import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { CdpCallFailedError } from './cdp-errors';
import type { PdfBrowser } from './pdf-render';

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake');

export interface FakePdfBrowserOptions {
  readonly status?: number;
  readonly loads?: boolean;
  readonly navigateError?: string;
  /** URLs the page requests after its document, each paused for the fence to decide. */
  readonly subresources?: readonly string[];
  /** Held until resolved: the print does not answer before it. */
  readonly printGate?: Promise<void>;
}

export interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

export interface FakePdfBrowser {
  readonly browser: PdfBrowser;
  readonly calls: FakeCall[];
  readonly closed: () => boolean;
}

export function fakePdfBrowser(options: FakePdfBrowserOptions = {}): FakePdfBrowser {
  const calls: FakeCall[] = [];
  const listeners = new Map<string, Set<CdpEventListener>>();
  let closed = false;
  let killed: () => void = () => undefined;
  const dead = new Promise<never>((_, reject) => {
    killed = () =>
      reject(new CdpCallFailedError({ method: 'Page.printToPDF', detail: 'browser closed' }));
  });
  dead.catch(() => undefined);
  const emit = (method: string, params: Record<string, unknown>): void => {
    for (const listener of listeners.get(method) ?? []) listener(params, 'S1');
  };
  const pause = (url: string, index: number): void =>
    emit('Fetch.requestPaused', {
      requestId: `r${String(index)}`,
      request: { url, method: 'GET', headers: { accept: '*/*' } },
    });
  const answer = async (method: string, params?: Record<string, unknown>): Promise<CdpResult> => {
    switch (method) {
      case 'Target.createTarget':
        return { result: { targetId: 'T1' } };
      case 'Target.attachToTarget':
        return { result: { sessionId: 'S1' } };
      case 'Page.navigate': {
        const url = typeof params?.['url'] === 'string' ? params['url'] : '';
        [url, ...(options.subresources ?? [])].forEach(pause);
        return { result: { frameId: 'F', errorText: options.navigateError ?? '' } };
      }
      case 'Runtime.evaluate':
        return { result: { result: { type: 'number', value: options.status ?? 200 } } };
      case 'Page.printToPDF':
        await Promise.race([options.printGate ?? Promise.resolve(), dead]);
        return { result: { data: PDF_BYTES.toBase64() } };
      default:
        return { result: {} };
    }
  };
  const connection: CdpConnection = {
    send: (method, params) => {
      calls.push({ method, params });
      return answer(method, params);
    },
    // A load that never comes answers `false` at its deadline — later than any reply, as in Chrome.
    once: () =>
      options.loads === false
        ? Promise.resolve()
            .then(() => undefined)
            .then(() => undefined)
            .then(() => false)
        : Promise.resolve(true),
    on: (method, listener) => {
      const set = listeners.get(method) ?? new Set<CdpEventListener>();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close: () => undefined,
  };
  return {
    browser: {
      connection,
      close: () => {
        closed = true;
        killed();
        return Promise.resolve();
      },
    },
    calls,
    closed: () => closed,
  };
}
