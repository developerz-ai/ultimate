// Whether a request's caller is THIS machine — the one question every dev-only surface asks
// (`x dev`'s `/_x`, the dev error overlay, the dev MCP agent token). One answer, owned where the
// address is resolved, so no surface trusts a relayed or forwarded "127.0.0.1" another refuses.

import { peerAddressClass } from '@ultimat3/core';

/** The headers a relay writes and a browser never sends. Any one of them means "not direct". */
export const RELAY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'] as const;

export type CallerLocality = 'local' | 'relayed' | 'remote';

/**
 * `local` only for a DIRECT loopback caller. A relay header present is `relayed` whatever the
 * hops say: with hops declared `ip` is the forwarded entry (forgeable by a LAN socket past a
 * short chain), and with none a loopback socket carrying one is a tunnel in front of this
 * process (`ngrok --host-header=rewrite`) speaking for the internet. `ip: null` is no socket at
 * all — an in-process `pipeline.handle()`, this process calling itself.
 */
export function callerLocality(input: {
  readonly ip: string | null;
  readonly headers: Headers;
}): CallerLocality {
  if (RELAY_HEADERS.some((name) => input.headers.has(name))) return 'relayed';
  if (input.ip === null) return 'local';
  return peerAddressClass(input.ip) === 'loopback' ? 'local' : 'remote';
}
