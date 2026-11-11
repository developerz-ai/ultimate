// What an island group's cache entry is verified against besides its own files' bytes: the files
// the bundler read (`inputFiles`), the directory listings that decide how an import resolves
// (`resolutionDirs`), and the environment every group shares (`environmentDigest`: the lockfile,
// the tsconfig chain, the package manifests). Each is a digest, read at most once per build.

// why: Bun ships no directory listing; `readdir` answers the names a resolver chooses between.
import { readdir } from 'node:fs/promises';
// why: Bun ships no path API; the bundler names its inputs relative to the building process's cwd.
import { basename, dirname, join, resolve } from 'node:path';
import { contentHash } from '@ultimat3/render/server';
import { hasPathSegment } from './path-segments';

/** One path's digest, or `undefined` when it is gone — each path read once per `buildIslands`. */
export type InputDigester = (path: string) => Promise<string | undefined>;

/** File bytes, hashed once per path. */
export function inputDigester(): InputDigester {
  const seen = new Map<string, Promise<string | undefined>>();
  return (path) => {
    let digest = seen.get(path);
    if (digest === undefined) {
      const file = Bun.file(path);
      digest = file.exists().then(async (ok) => (ok ? contentHash(await file.text()) : undefined));
      seen.set(path, digest);
    }
    return digest;
  };
}

/** A directory's sorted entry names, hashed once per path — `undefined` when it is gone. */
export function listingDigester(): InputDigester {
  const seen = new Map<string, Promise<string | undefined>>();
  return (dir) => {
    let digest = seen.get(dir);
    if (digest === undefined) {
      digest = readdir(dir).then(
        (names) => contentHash([...names].sort().join('\n')),
        () => undefined,
      );
      seen.set(dir, digest);
    }
    return digest;
  };
}

/**
 * Metafile inputs (cwd-relative, some virtual) → the files on disk, absolute. `node_modules` is
 * left to the key: it changes only with an install, and the lockfile's digest is in it.
 */
export async function inputFiles(listed: readonly string[]): Promise<readonly string[]> {
  const cwd = process.cwd();
  const paths = [...new Set(listed.map((one) => resolve(cwd, one)))].filter(
    (path) => !hasPathSegment(path, 'node_modules'),
  );
  const present = await Promise.all(paths.map((path) => Bun.file(path).exists()));
  return paths.filter((_, index) => present[index]).sort();
}

/**
 * The directories whose listing decides what each input resolved AS: its own (a `util.ts` added
 * beside `util/` takes `./util` from `util/index.ts`; a `.tsx` beside a `.ts` takes the stem), and
 * for an `index.*` the parent too, where the shadowing file lands. A listing is the whole rule —
 * any added or removed name there is a miss, which over-invalidates only that group.
 */
export function resolutionDirs(inputs: readonly string[]): readonly string[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    dirs.add(dirname(input));
    if (basename(input).startsWith('index.')) dirs.add(dirname(dirname(input)));
  }
  return [...dirs].sort();
}

/** `extends` of a tsconfig, when it names a relative file: the chain a `paths` change lives in. */
async function tsconfigChain(file: string, seen: Set<string>): Promise<readonly string[]> {
  if (seen.has(file) || !(await Bun.file(file).exists())) return [];
  seen.add(file);
  const text = await Bun.file(file).text();
  const named = /"extends"\s*:\s*"(\.[^"]+)"/.exec(text)?.[1];
  if (named === undefined) return [text];
  const next = resolve(dirname(file), named.endsWith('.json') ? named : `${named}.json`);
  return [text, ...(await tsconfigChain(next, seen))];
}

/**
 * Everything every group's resolution shares, hashed once per build: the nearest `bun.lock` (the
 * third-party code installed), and each `package.json` (`imports`, `exports`, workspaces) and
 * `tsconfig.json` (`paths`, with its relative `extends` chain) at the app root, each `apps/*`, and
 * the lockfile's directory.
 */
export async function environmentDigest(root: string): Promise<string> {
  let lockDir: string | undefined;
  for (let dir = root; lockDir === undefined; dir = dirname(dir)) {
    if (await Bun.file(join(dir, 'bun.lock')).exists()) lockDir = dir;
    else if (dirname(dir) === dir) break;
  }
  const apps: string[] = [];
  for await (const one of new Bun.Glob('apps/*/package.json').scan({ cwd: root })) {
    apps.push(dirname(join(root, one)));
  }
  const dirs = [...new Set([root, ...apps.sort(), ...(lockDir === undefined ? [] : [lockDir])])];
  const parts: string[] = [];
  const seen = new Set<string>();
  if (lockDir !== undefined) parts.push(await Bun.file(join(lockDir, 'bun.lock')).text());
  for (const dir of dirs) {
    const manifest = Bun.file(join(dir, 'package.json'));
    parts.push(dir, (await manifest.exists()) ? await manifest.text() : '');
    parts.push(...(await tsconfigChain(join(dir, 'tsconfig.json'), seen)));
  }
  return contentHash(parts.join('\0'));
}
