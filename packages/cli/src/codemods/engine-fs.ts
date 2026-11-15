// The `CodemodApp` over a real app root: posix paths relative to it in and out, refused when they
// resolve outside it. A glob skips `node_modules/` and `.git/`, which no scaffold-owned file is in.

// why: Bun has no file-removal primitive; `rm` with `force` makes a removal of nothing no error.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-resolve primitive; containment is decided on the resolved path.
import { resolve, sep } from 'node:path';
import { ScaffoldPathEscapeError } from '../errors';
import type { CodemodApp } from './codemod';

const SKIPPED = /^(?:node_modules|\.git)\//;

const contained = (root: string, path: string): string => {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target === base || !target.startsWith(`${base}${sep}`)) {
    throw new ScaffoldPathEscapeError({
      path,
      dir: base,
      fix: 'x upgrade codemods --from 0.0.0 --dry-run --json   # names the codemod that asked for the path; report it with that output',
    });
  }
  return target;
};

export function fsCodemodApp(root: string): CodemodApp {
  return {
    root,
    async read(path) {
      const file = Bun.file(contained(root, path));
      return (await file.exists()) ? await file.text() : undefined;
    },
    async write(path, source) {
      await Bun.write(contained(root, path), source);
    },
    async remove(path) {
      await rm(contained(root, path), { force: true });
    },
    exists: (path) => Bun.file(contained(root, path)).exists(),
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
