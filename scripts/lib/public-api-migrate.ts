// A format-1 lock holds hashes only, so no change against it can be classified. Re-baseline it from
// the release tags: emit each tag's surface, newest first from the lock's own version, and adopt a
// tag's shape for every symbol whose hash it reproduces. A symbol no tag reproduces keeps its bare
// hash — any change to it stays a break. Once: `--write` then commits format 2.

// why: Bun has no recursive mkdir/remove or symlink of its own; node:fs/promises is the only way.
import { mkdir, rm, symlink, unlink } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { localBin } from './local-bin';
import { toPosix } from './posix-path';
import type { ApiSymbol } from './public-api-compat';
import type { ApiPackage } from './public-api-emit';
import type { ApiLock, ApiSnapshot } from './public-api-lock';
import { readSurface } from './public-api-surface';
import { run } from './run';

/** How many release tags back a format-1 symbol is looked for: one emit each, ~5 s. */
export const MIGRATION_TAG_DEPTH = 4;

export interface Migrated {
  readonly entries: ApiSnapshot;
  /** The tags whose surface was read. */
  readonly tags: readonly string[];
  /** Symbols still without a shape: no tag read reproduced their hash. */
  readonly unresolved: number;
}

/** `v<version>` and the release tags before it, newest first; none when the tag is not fetched. */
export async function tagsFrom(root: string, version: string): Promise<readonly string[]> {
  const listed = await run(['git', 'tag', '--list', 'v*', '--sort=-v:refname'], { cwd: root });
  if (!listed.ok) return [];
  const tags = listed.output.split('\n').map((line) => line.trim());
  const start = tags.indexOf(`v${version}`);
  return start === -1 ? [] : tags.slice(start, start + MIGRATION_TAG_DEPTH);
}

/** `tag`'s surface: its `packages/` and `tsconfig.base.json` emitted with this tree's modules. */
async function tagSurface(
  root: string,
  tag: string,
  packages: readonly ApiPackage[],
  tsc: string,
): Promise<ApiSnapshot | undefined> {
  const dir = toPosix(`${tmpdir()}/ultimate-public-api-${process.pid}-${tag}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const modules = `${dir}/node_modules`;
  try {
    const archive = `${dir}.tar`;
    const paths = ['packages', 'tsconfig.base.json'];
    const made = await run(['git', 'archive', '--format=tar', '-o', archive, tag, '--', ...paths], {
      cwd: root,
    });
    if (!made.ok) return undefined;
    const unpacked = await run(['tar', '-xf', archive, '-C', dir], { cwd: root });
    await rm(archive, { force: true });
    if (!unpacked.ok) return undefined;
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(`${toPosix(root)}/node_modules`, modules, 'junction');
    const present: ApiPackage[] = [];
    for (const pkg of packages) {
      if (await Bun.file(`${dir}/packages/${pkg.dir}/package.json`).exists()) present.push(pkg);
    }
    const surface = await readSurface(dir, present, tsc);
    return surface.ok ? surface.tree : undefined;
  } finally {
    await unlink(modules).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/** The format-1 lock's entries with every shape the release tags can supply. */
export async function migrateLock(
  root: string,
  lock: ApiLock,
  packages: readonly ApiPackage[],
  tags?: readonly string[],
  tsc: string = localBin(root, 'tsc'),
): Promise<Migrated> {
  const entries = new Map<string, Record<string, ApiSymbol>>();
  const pending = new Set<string>();
  for (const [specifier, names] of Object.entries(lock.entries)) {
    entries.set(specifier, { ...names });
    for (const [name, one] of Object.entries(names)) {
      if (one.shape === undefined) pending.add(`${specifier}\u0000${name}`);
    }
  }
  const read: string[] = [];
  for (const tag of tags ?? (await tagsFrom(root, lock.version))) {
    if (pending.size === 0) break;
    const surface = await tagSurface(root, tag, packages, tsc);
    read.push(tag);
    if (surface === undefined) continue;
    for (const key of [...pending]) {
      const [specifier = '', name = ''] = key.split('\u0000');
      const tagged = surface[specifier]?.[name];
      const names = entries.get(specifier);
      if (tagged === undefined || names === undefined || names[name]?.hash !== tagged.hash)
        continue;
      names[name] = tagged;
      pending.delete(key);
    }
  }
  return { entries: Object.fromEntries(entries), tags: read, unresolved: pending.size };
}
