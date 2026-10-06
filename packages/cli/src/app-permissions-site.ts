// Single responsibility: a declaration site — a stack FRAME `@ultimat3/policy` recorded for a
// `defineRoles()` or `definePermissions()` call — reduced to the file it names, absolute or
// app-root-relative. Both `policy` step questions key their findings by it.

// why: Bun ships no path API, and `posix.relative` is what turns a frame's absolute path into the
// app-root-relative one every finding is keyed by — on POSIX-normalised input, so a Windows frame
// and root compare the same way on every host.
import { posix } from 'node:path';

/**
 * The location at the END of a frame — `at fn (<path>:<line>:<col>)` or `at <path>:<line>:<col>` —
 * read lazily from the first place a path can start, so a `(` INSIDE the path (`/srv/shop (copy)/`)
 * is part of it, and a drive letter (`C:\…`) is a path start too. Anchored at the end because a
 * frame's location is always its last token, and the function name before it is not a path.
 */
const FRAME_LOCATION = /(?:^|[\s(])((?:[A-Za-z]:)?[\\/].*?\.[cm]?tsx?)(?::\d+){0,2}\)?\s*$/;

/** The absolute source path a frame names, exactly as written, or `undefined`. */
export function frameFile(site: string): string | undefined {
  return FRAME_LOCATION.exec(site)?.[1];
}

/**
 * `\` → `/`, and a drive letter rooted like a POSIX path with its case folded (`C:\a` → `/c:/a`):
 * `@ultimat3/policy`'s `declaration-site.ts` compares frames `/`-normalised for the same reason —
 * on Windows neither a frame nor a root holds a `/`, and a shell spells the drive either way.
 */
const comparable = (path: string): string => {
  const slashed = path.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\//.exec(slashed);
  return drive === null ? slashed : `/${(drive[1] ?? '').toLowerCase()}:${slashed.slice(2)}`;
};

/** `file` relative to `root`, `/`-separated, whichever OS printed either of them. */
export const rootRelative = (root: string, file: string): string =>
  posix.relative(comparable(root), comparable(file));

/**
 * The frame's file relative to the app root, or `undefined` outside it: a locator nobody can act on
 * is worse than none. The frame is the only place the declaring module's name exists by the time
 * the declaration runs.
 */
export function siteFile(root: string, site: string): string | undefined {
  const absolute = frameFile(site);
  if (absolute === undefined) return undefined;
  const rel = rootRelative(root, absolute);
  return rel.startsWith('..') || rel.length === 0 || rel.startsWith('/') ? undefined : rel;
}
