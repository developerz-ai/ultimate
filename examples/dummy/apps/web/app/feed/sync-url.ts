/**
 * Where the browser dials the sync node.
 *
 * `SYNC_URL` when the deployment states one — the sync node is its own container, and behind an
 * ingress it has its own hostname. Otherwise it is DERIVED from `APP_URL` the way the framework
 * derives it everywhere else: the node listens on `PORT + 1` (`syncPortFor` in
 * `packages/cli/src/dev-sync.ts`, and `docker/helm` reads `PORT = .port - 1` back off it), so a
 * laptop running `bin/dev` needs no second variable.
 *
 * One expression with one answer, resolved on the SERVER and passed to the island as a prop: a
 * browser deriving it from `location` would be a second rule, and it would be the wrong one behind
 * any proxy that does not publish the node on a neighbouring port.
 */

/** The framework's own offset, restated where the app needs it. `x dev` binds the node here. */
const SYNC_PORT_OFFSET = 1;

/** A `Map`, not an object literal: the key is a value off a URL the deployment wrote. */
const DEFAULT_PORTS = new Map<string, number>([
  ['http:', 80],
  ['https:', 443],
]);

export function syncUrlFrom(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env['SYNC_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const appUrl = env['APP_URL'];
  if (appUrl === undefined || appUrl === '') return '';
  const url = URL.parse(appUrl);
  if (url === null) return '';
  const port = url.port === '' ? DEFAULT_PORTS.get(url.protocol) : Number(url.port);
  if (port === undefined || !Number.isInteger(port)) return '';
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.hostname}:${String(port + SYNC_PORT_OFFSET)}`;
}
