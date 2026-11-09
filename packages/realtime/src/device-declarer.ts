// The FILE that called `deviceSocket()`: the one fact that tells `x dev`'s rescan an edited
// declaration (same module, re-evaluated) from another module taking its path. The policy
// package's `declaration-site.ts` reads a stack for the same reason — nothing else names the
// declaring module once its top level is running.

/** `\` → `/`: a Windows frame and `import.meta.path` must compare on both platforms. */
const toPosix = (text: string): string => text.replaceAll('\\', '/');

/** The path of a frame (`at f (/a/b.ts:1:2)` or `at /a/b.ts:1:2`), without its line and column. */
const fileOf = (frame: string): string | null =>
  /(?:\(|at )([^()]+?):\d+:\d+\)?$/.exec(frame.trim())?.[1] ?? null;

/**
 * The first file in `stack` that is none of `internal`, or `null` when no frame names one — then
 * nothing can be compared, and the caller decides as it did before it could. JSC drops the frame
 * of a strict-mode tail call, so an app wrapper that `return`s `deviceSocket(…)` reads as its own
 * caller: the same answer on every evaluation of one module, which is all the comparison needs.
 */
export function pickDeclarer(stack: string, internal: readonly string[]): string | null {
  const own = new Set(internal.map(toPosix));
  for (const frame of stack.split('\n').slice(1)) {
    const file = fileOf(frame);
    if (file !== null && !own.has(toPosix(file))) return toPosix(file);
  }
  return null;
}

/** Not a throw: the `Error` exists only for its stack. Line and column drop — an edit moves them. */
export function declarerFile(internal: readonly string[]): string | null {
  const stack = new Error().stack;
  return stack === undefined ? null : pickDeclarer(stack, [import.meta.path, ...internal]);
}
