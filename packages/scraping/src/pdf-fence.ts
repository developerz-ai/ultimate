// The print's request fence, on the page's own session: every request pauses (`Fetch`); one to the
// route's ORIGIN continues with the app's headers, every other — an off-origin redirect too — is
// failed before it leaves. Never `Network.setExtraHTTPHeaders`: it sent the print token to any
// `<img src>` a post carried, and let the page dial internal hosts.

import type { CdpConnection } from './cdp-connection';

export interface PdfFenceInit {
  readonly connection: CdpConnection;
  readonly sessionId: string;
  /** `new URL(route).origin` — scheme, host and port, compared whole. */
  readonly origin: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

interface Paused {
  readonly requestId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, unknown>>;
}

const readPaused = (params: Record<string, unknown>): Paused | undefined => {
  const request = params['request'];
  const requestId = params['requestId'];
  if (typeof requestId !== 'string' || typeof request !== 'object' || request === null) {
    return undefined;
  }
  const url = 'url' in request && typeof request.url === 'string' ? request.url : '';
  const headers =
    'headers' in request && typeof request.headers === 'object' && request.headers !== null
      ? Object.fromEntries(Object.entries(request.headers))
      : {};
  return { requestId, url, headers };
};

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The request's own headers with the app's laid over them, case-insensitively, as CDP's list. */
function mergedHeaders(
  own: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, string>>,
): { readonly name: string; readonly value: string }[] {
  const overridden = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
  const kept = Object.entries(own)
    .filter(([name, value]) => typeof value === 'string' && !overridden.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value: String(value) }));
  return [...kept, ...Object.entries(extra).map(([name, value]) => ({ name, value }))];
}

/**
 * Raise the fence before the page navigates. Answers its removal. A decision the browser refuses
 * (the target already gone) is dropped: the page's own load then fails, which is the error to read.
 */
export async function raisePdfFence(init: PdfFenceInit): Promise<() => void> {
  const { connection, sessionId } = init;
  const extra = init.headers ?? {};
  const decide = (paused: Paused): Promise<unknown> => {
    if (originOf(paused.url) !== init.origin) {
      return connection.send(
        'Fetch.failRequest',
        { requestId: paused.requestId, errorReason: 'BlockedByClient' },
        sessionId,
      );
    }
    return connection.send(
      'Fetch.continueRequest',
      Object.keys(extra).length === 0
        ? { requestId: paused.requestId }
        : { requestId: paused.requestId, headers: mergedHeaders(paused.headers, extra) },
      sessionId,
    );
  };
  const off = connection.on('Fetch.requestPaused', (params, from) => {
    if (from !== sessionId) return;
    const paused = readPaused(params);
    if (paused !== undefined) void decide(paused).catch(() => undefined);
  });
  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
  return off;
}
