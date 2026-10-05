// One answer to "this host path, written with `/`". `relative()` and `Bun.Glob` answer in the
// host's separator, so on Windows a `\` reached an import specifier (`x fix` wrote
// `import '..\\foo'`, which breaks every Linux teammate), a fix line and a sort key. Every such
// result passes through here — `bun run posix-relative` refuses a `relative(` that does not.

// why: Bun ships no path API; `node:path` owns `relative`, and a test hands in its `win32` half to
// prove the Windows answer on a Linux runner.
import * as hostPath from 'node:path';

/**
 * The one method `posixRelative` asks of a path module — structural, not `PlatformPath`: the
 * scaffold's typecheck resolves `node:path` without that name exported (TS2305).
 */
export interface RelativeHost {
  readonly relative: (from: string, to: string) => string;
}

/**
 * `path` with every `\` written as `/`. Unconditional rather than keyed to the host's `sep`: a key,
 * a specifier and a fix line are POSIX on every host, and a Windows-shaped path handed to a Linux
 * process (a CI log, a test fixture) must come out the same as it would on Windows.
 */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** `relative(from, to)` in POSIX form. `host` is the platform's own path module but for a test. */
export function posixRelative(from: string, to: string, host: RelativeHost = hostPath): string {
  return toPosix(host.relative(from, to));
}
