// One responsibility: the ONE spelling of a filesystem path the stylesheet registry compares — `/`
// separators, `..` folded, a Windows drive letter upper-cased — so "is this sheet below that
// directory" means the same on Windows, where Bun hands every path over as `D:\app\…`, as on POSIX.

// why: Bun ships no path API, and a relative root must be resolved against the working directory.
import { posix, resolve } from 'node:path';

/** POSIX-absolute (`/srv/app`), drive-absolute (`D:\app`, `d:/app`) or UNC (`\\host\share`). */
const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/;

/**
 * Comparable, never displayed: the registry keeps every sheet under the path it was handed and only
 * COMPARES through this. An absolute path is not re-resolved, because `resolve('/app')` on Windows
 * is `D:\app` — a drive the sheets a caller handed as `/app/…` never carry.
 */
export function comparablePath(path: string): string {
  const absolute = ABSOLUTE.test(path) ? path : resolve(path);
  const slashed = posix.normalize(absolute.replaceAll('\\', '/'));
  const drive = slashed.replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`);
  // A trailing separator is dropped so `${dir}/` is one prefix — except the filesystem root itself.
  const trimmed = drive.replace(/\/+$/, '');
  return trimmed === '' || trimmed.endsWith(':') ? `${trimmed}/` : trimmed;
}

/** `path` sits below `dir` — both already `comparablePath`. A sibling sharing a prefix does not. */
export function isPathBelow(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** `path` relative to `dir` when it sits below it, else `path` — both already `comparablePath`. */
export function pathBelow(path: string, dir: string): string {
  if (!isPathBelow(path, dir)) return path;
  return path.slice(dir.endsWith('/') ? dir.length : dir.length + 1);
}
