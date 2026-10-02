// Single responsibility: where the process logger's lines go under `bun test`. Both preloads
// import this FIRST, before anything that loads `@ultimat3/core`.
//
//   LOG_LEVEL unset            a green run prints the reporter and nothing else: every line is dropped
//   LOG_LEVEL=info (or lower)  the escape hatch — `LOG_LEVEL=info bun test <file>` prints them
//   LOG_LEVEL=warn (or higher) the terminal shows that level and above
//
// The third row is a FILTER ON THE TERMINAL, never the logger's own threshold. Core reads
// `LOG_LEVEL` once, when it is first imported, so `LOG_LEVEL=error bun test` used to raise the
// process logger itself to `error` — and a test that installs a sink to assert on an `info` audit
// line collected nothing and failed for an environment variable. The level is therefore pinned at
// `info` for the one moment core loads, and what the author named decides what is PRINTED.
//
// A test that asserts on log output hands `createLogger({ level, writer })` its own writer, or
// installs its own `setLogSink` and restores the previous one. Never `process.stdout`.

import type { LogLevel } from '@ultimat3/core';

/** The levels above `info`, least severe first: the ones a named `LOG_LEVEL` must not cost a sink. */
const ABOVE_INFO = ['warn', 'error', 'fatal', 'silent'] as const satisfies readonly LogLevel[];

export type LogRouting =
  | { readonly lines: 'dropped' }
  | { readonly lines: 'printed' }
  | { readonly lines: 'filtered'; readonly from: (typeof ABOVE_INFO)[number] };

/**
 * What a named `LOG_LEVEL` means for a test process. `info` and below are core's own to print, at
 * the level named — asking for `debug` is asking for more lines, and a collecting sink is handed
 * them too. Anything core would not read as a level is `info` there, so it is `printed` here.
 */
export function logRouting(named: string | undefined): LogRouting {
  if (named === undefined || named === '') return { lines: 'dropped' };
  const from = ABOVE_INFO.find((level) => level === named);
  return from === undefined ? { lines: 'printed' } : { lines: 'filtered', from };
}

const named = Bun.env['LOG_LEVEL'];
const routing = logRouting(named);

// Core's `logger` is built at module init from this variable, so the pin goes in before the
// import and the author's value goes back after it: a child this process spawns inherits what
// was named, never the pin. A dynamic import, because a static one is hoisted above this line.
if (routing.lines === 'filtered') Bun.env['LOG_LEVEL'] = 'info';
const { setLogSink } = await import('@ultimat3/core');

if (routing.lines === 'dropped') {
  setLogSink(() => undefined);
} else if (routing.lines === 'filtered') {
  Bun.env['LOG_LEVEL'] = routing.from;
  const shown = new Set<LogLevel>(ABOVE_INFO.slice(ABOVE_INFO.indexOf(routing.from)));
  // Core's own split: `error` and above to stderr, the rest to stdout.
  setLogSink((line, level) => {
    if (shown.has(level)) (level === 'warn' ? process.stdout : process.stderr).write(`${line}\n`);
  });
}
