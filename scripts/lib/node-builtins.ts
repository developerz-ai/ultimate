// Node's own builtin modules, written out once for every guard that asks "is this specifier a
// builtin?" (`node-imports.ts`, `test-mock-builtin.ts`). Written out, not read from `node:module`'s
// `builtinModules`: Bun's copy also lists `bun`, `ws` and `undici`, which are not Node APIs, and a
// fact that moves with the runtime moves every ratchet built on it.

/** Node's builtins, as a BARE specifier reaches them — `'fs'`, `require('child_process')`. */
export const BARE_BUILTINS: ReadonlySet<string> = new Set(
  (
    'assert async_hooks buffer child_process cluster console constants crypto dgram ' +
    'diagnostics_channel dns domain events fs http http2 https inspector module net os path ' +
    'perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls ' +
    'trace_events tty url util v8 vm wasi worker_threads zlib'
  ).split(' '),
);

/** `node:fs`, `fs`, `fs/promises` — and not `fsevents`, `./fs`, `ws` or `bun`. */
export const isBuiltinSpecifier = (specifier: string): boolean =>
  specifier.startsWith('node:') || BARE_BUILTINS.has(specifier.split('/')[0] as string);
