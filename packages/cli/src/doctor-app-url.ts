// `x doctor`'s APP_URL rule, pure: a set APP_URL must be an origin a browser can match, and a
// loopback one must name the port `x dev` serves on — OAuth's redirect, absolute links and the sync
// node's admitted origin all read it, and a laptop origin on another port reaches another server.

import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import { isLoopbackHostname } from './loopback-host';
import type { Finding } from './output';
import { findingFrom } from './output';
import { syncOriginsFrom } from './sync-url';

/**
 * Unset is no finding: `x dev` serves without one, and a production build warns on its own
 * (`originWarning`). A public origin is not judged against the dev port — that is the deploy's
 * address, not this machine's. The parse is the sync boot's own (`syncOriginsFrom`), so doctor
 * refuses exactly the values the boot would.
 */
export function appUrlFindings(raw: string | undefined, port: number): readonly Finding[] {
  let origins: readonly string[];
  try {
    origins = syncOriginsFrom({ APP_URL: raw });
  } catch (error) {
    return [findingFrom(error)];
  }
  const origin = origins[0];
  if (origin === undefined) return [];
  const url = new URL(origin);
  if (!isLoopbackHostname(url.hostname)) return [];
  const declared = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (declared === port) return [];
  const wanted = `${url.protocol}//${url.hostname}:${String(port)}`;
  return [
    {
      code: 'X_APP_URL_PORT_MISMATCH',
      cause: `APP_URL is ${origin}, but x dev serves this app on port ${String(port)} — OAuth redirects, absolute links and the sync origin would point at another server`,
      fix: `export APP_URL=${renderFixShellArg(wanted, 'http://localhost:3000')}`,
      docs: ERROR_DOCS_URL,
    },
  ];
}
