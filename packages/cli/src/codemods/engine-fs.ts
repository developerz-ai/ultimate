// The `CodemodApp` over a real app root: posix paths relative to it in and out, refused when they
// resolve outside it — lexically or through a symlink. A glob skips `node_modules/` and `.git/`,
// which no scaffold-owned file is in.

// why: Bun has no file-removal, rename, lstat or realpath primitive; `rm` with `force` makes a
// removal of nothing no error, `rename` lands a write whole, and only `realpath` answers where a
// symlinked component really points; `stat`/`chmod` carry a rewritten file's mode across the rename.
import { chmod, lstat, realpath, rename, rm, stat } from 'node:fs/promises';
// why: Bun exposes no path-resolve primitive; containment is decided on the resolved path.
import { dirname, resolve, sep } from 'node:path';
import { ScaffoldPathEscapeError } from '../errors';
import type { CodemodApp } from './codemod';

const SKIPPED = /^(?:node_modules|\.git)\//;

const FIX =
  'x upgrade codemods --from 0.0.0 --dry-run --json   # names the codemod that asked for the path; report it with that output';

const inside = (base: string, target: string): boolean => target.startsWith(`${base}${sep}`);

/** Nothing at this path (or a file where a directory was named): keep walking up. */
const absent = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * The absolute path, once it is inside the root twice over: lexically, and after following every
 * symlink on the way — the deepest component that exists is resolved, and must land under the
 * root's own real path. A dangling link resolves nowhere, so it is refused rather than followed.
 */
async function contained(root: string, path: string): Promise<string> {
  const base = resolve(root);
  const target = resolve(base, path);
  const refuse = (): never => {
    throw new ScaffoldPathEscapeError({ path, dir: base, fix: FIX });
  };
  if (target === base || !inside(base, target)) refuse();
  const realBase = await realpath(base);
  for (let probe = target; probe !== base; probe = dirname(probe)) {
    const exists = await lstat(probe).then(
      () => true,
      (error: unknown) => (absent(error) ? false : Promise.reject(error)),
    );
    if (!exists) continue;
    const real = await realpath(probe).catch(refuse);
    if (real !== realBase && !inside(realBase, real)) refuse();
    break;
  }
  return target;
}

/**
 * `source` at `target`, whole or not at all: written beside it under a unique name, then renamed
 * over it — a crash leaves the old file or the new one, never half of one, and no stray temp.
 */
export async function landFile(
  target: string,
  source: string,
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  const temp = `${target}.x-codemod-${String(process.pid)}-${crypto.randomUUID()}.tmp`;
  // The temp file is born 0644: without the target's mode carried over, the rename drops `+x` —
  // 31.49.0's merge-drivers codemod turned an app's executable `bin/setup.ts` into a plain file.
  const mode = await stat(target).then(
    (found) => found.mode,
    () => undefined,
  );
  await Bun.write(temp, source);
  try {
    if (mode !== undefined) await chmod(temp, mode);
    await move(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function fsCodemodApp(root: string): CodemodApp {
  return {
    root,
    async read(path) {
      const file = Bun.file(await contained(root, path));
      return (await file.exists()) ? await file.text() : undefined;
    },
    async write(path, source) {
      await landFile(await contained(root, path), source);
    },
    async remove(path) {
      await rm(await contained(root, path), { force: true });
    },
    exists: async (path) => Bun.file(await contained(root, path)).exists(),
    async glob(pattern) {
      const paths: string[] = [];
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: true })) {
        const posix = path.replaceAll('\\', '/');
        if (!SKIPPED.test(posix)) paths.push(posix);
      }
      return paths.sort();
    },
  };
}
