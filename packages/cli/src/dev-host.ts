// Which interface `x dev` binds: `--host`, else loopback. Validated at the boundary, because a
// typo handed to `Bun.serve` fails as an uncoded bind error and a hostname binds wherever DNS
// points today. A wider bind is something the caller types; loopback stays the default.

import { classifyAddress } from '@ultimat3/core';
import { BadFlagError } from './errors';
import { isLoopbackHostname } from './loopback-host';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import { DEV_BINDING } from './web-binding';

const unbracketed = (raw: string): string =>
  raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;

/** `localhost` or an address LITERAL — `0.0.0.0` and `::` included — never a name to resolve. */
export function devHostFor(args: ParsedArgs): string {
  const raw = flagString(args, 'host');
  if (raw === undefined) return DEV_BINDING.hostname;
  const host = unbracketed(raw.trim());
  if (host.toLowerCase() === 'localhost') return 'localhost';
  if (classifyAddress(host) !== undefined) return host;
  throw new BadFlagError({
    flag: 'host',
    command: 'dev',
    reason: `expects localhost or an IP address literal (IPv4, IPv6, 0.0.0.0, ::), got "${raw}"`,
    fix: 'x dev --host 0.0.0.0',
  });
}

/**
 * The url a client on THIS machine dials. A wildcard bind answers on loopback too, and Bun reports
 * it as `http://0.0.0.0:<port>` — an address a browser may refuse and `/_x` (a loopback Host
 * only) always does — so it is reported as `localhost`. A specific address is reported as itself.
 */
export function dialableUrl(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null || classifyAddress(parsed.hostname) !== 'unspecified') return url;
  parsed.hostname = 'localhost';
  return parsed.origin;
}

/** `/_x` on this server, or null when its bind leaves no loopback address to reach it on. */
export function dashboardUrl(url: string): string | null {
  const parsed = URL.parse(url);
  return parsed !== null && isLoopbackHostname(parsed.hostname) ? `${parsed.origin}/_x` : null;
}
