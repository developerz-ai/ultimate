// The argument list a launched browser gets: the caller's own, then the exit. The exit is the
// session's — the driver's `proxy` or the run's `egress` — so it is appended LAST and a caller
// switch that would decide the route instead is refused rather than ranked.

import { launchArgsInvalid } from './error-throws-session';

/**
 * Every switch Chrome reads a proxy decision from. Matched on the switch NAME, case-folded and
 * with either prefix POSIX Chrome accepts (`--` and `-`), so a value that merely mentions a proxy
 * (`--user-agent=proxy-server-test`) is not refused.
 */
const ROUTE_SWITCHES = new Set([
  'proxy-server',
  'proxy-bypass-list',
  'proxy-pac-url',
  'proxy-auto-detect',
  'no-proxy-server',
]);

const switchName = (arg: string): string | undefined => {
  const match = /^--?([^=]+)/.exec(arg);
  return match?.[1]?.toLowerCase();
};

/**
 * `undefined` when the launch carries no args at all — the launcher's own defaults stay untouched
 * then. Refused with `X_SCRAPE_LAUNCH_ARGS_INVALID` before anything starts: a browser launched on a
 * second route is a session that reports one exit and leaves the worker by another.
 */
export function launchArgs(
  callerArgs: unknown,
  proxyArg: string | undefined,
): string[] | undefined {
  if (callerArgs !== undefined) {
    if (!Array.isArray(callerArgs) || !callerArgs.every((arg) => typeof arg === 'string')) {
      throw launchArgsInvalid('is not an array of strings', false);
    }
    for (const arg of callerArgs as readonly string[]) {
      const name = switchName(arg);
      if (name !== undefined && ROUTE_SWITCHES.has(name)) {
        throw launchArgsInvalid(
          `sets --${name}, which decides the route this session leaves by`,
          true,
        );
      }
    }
  }
  const args = [...((callerArgs as readonly string[] | undefined) ?? [])];
  if (proxyArg !== undefined) args.push(`--proxy-server=${proxyArg}`);
  return args.length === 0 ? undefined : args;
}
