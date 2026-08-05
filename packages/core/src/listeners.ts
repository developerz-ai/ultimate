// Single responsibility: the sockets this process is currently listening on. A request to one of
// them is the process calling itself, not egress — which is how a sealed test network can let a
// booted server reach its own port without an allowlist entry per kernel-assigned port.

import { assert } from './assert';

interface Listener {
  readonly origin: string;
  count: number;
}

/**
 * Every spelling of "this machine". A wildcard bind is reachable over loopback, so it collapses
 * to the same key: a server on `0.0.0.0:3000` answers `http://localhost:3000`.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

const listeners = new Map<string, Listener>();

const portOf = (url: URL): string => {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80';
};

/** Identity is host+port, not the origin string: the same socket has several valid spellings. */
const keyOf = (url: URL): string => {
  const host = url.hostname.toLowerCase();
  return `${LOOPBACK_HOSTS.has(host) ? 'loopback' : host}:${portOf(url)}`;
};

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/**
 * Announce a socket this process just opened; call the returned release when it closes. Releasing
 * twice is a no-op, so a manual `stop()` and a SIGTERM drain may both call it. Refcounted, so two
 * servers on one origin do not un-announce each other.
 */
export function markListening(origin: string): () => void {
  const url = parseUrl(origin);
  assert(
    url !== undefined,
    `not a URL: ${origin}`,
    'pass the server origin, e.g. markListening(server.url.origin)',
  );
  const key = keyOf(url);
  const existing = listeners.get(key);
  if (existing === undefined) listeners.set(key, { origin: url.origin, count: 1 });
  else existing.count += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = listeners.get(key);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count <= 0) listeners.delete(key);
  };
}

/** The origins this process is serving right now, in announce order. */
export const listeningOrigins = (): readonly string[] =>
  [...listeners.values()].map((listener) => listener.origin);

/** True when the URL points at a socket this process opened — same port, any loopback spelling. */
export function isSelfOrigin(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== undefined && listeners.has(keyOf(parsed));
}

/** Test-only: forget every announced socket. */
export function resetListeners(): void {
  listeners.clear();
}
