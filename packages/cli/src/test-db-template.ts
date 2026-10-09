// Single responsibility: where the app's migrated test-database templates live and how one is read
// and written. A template is a PGlite data directory dumped after the framework schema and every
// migration ran (`test-database.ts` builds it), keyed by everything that went into it, under the
// APP ROOT's `.x/test-db` — never the cwd's.
//
// Writing a new key evicts the old ones (#738): nothing did, and an app's `.x/test-db` held one
// ~60 MB file per migration state it ever had — 72, 4.2 GB. The newest previous one stays, since a
// second run still on the old migrations may be reading it. No lock is needed: a template is read
// in ONE read, a missing one is a miss, and a write is a temp name renamed into place.

// why: Bun has no mkdir, rename or remove.
import { mkdir, rename, rm } from 'node:fs/promises';
// why: Bun ships no path joiner.
import { basename, dirname } from 'node:path';
import { appStatePath, evictCacheFiles } from '@ultimat3/core';

/** `.x/<this>` under the app root. */
export const TEST_DB_DIR = 'test-db';

const TEMPLATE = /^pglite-[0-9a-f]{16}\.tar$/;
const PARTIAL = /^pglite-[0-9a-f]{16}\.tar\..+\.partial$/;

/** Sixteen hex characters over every input, each length-prefixed so `ab|c` and `a|bc` differ. */
export function templateKey(parts: readonly string[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const part of parts) hasher.update(`${String(part.length)}:${part}`);
  return hasher.digest('hex').slice(0, 16);
}

/** `<app root>/.x/test-db/pglite-<key>.tar`, for a process started anywhere inside the app. */
export const templatePath = (from: string, key: string): string =>
  appStatePath(from, TEST_DB_DIR, `pglite-${key}.tar`);

/** The whole template in memory, or `undefined` for one that is absent or vanished mid-read. */
export async function readTemplate(path: string): Promise<Blob | undefined> {
  try {
    return new Blob([await Bun.file(path).arrayBuffer()]);
  } catch {
    return undefined;
  }
}

/**
 * Atomic: several workers may build the same template at once, each renames its own temp file into
 * place, and a reader sees a whole template or none. Then the eviction. Best effort throughout: a
 * template that cannot be written costs the next file a rebuild, which is what it cost before.
 */
export async function writeTemplate(path: string, template: Blob): Promise<void> {
  const partial = `${path}.${String(process.pid)}.${crypto.randomUUID()}.partial`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(partial, template);
    await rename(partial, path);
  } catch {
    await rm(partial, { force: true }).catch(() => undefined);
    return;
  }
  await evictCacheFiles({
    dir: dirname(path),
    current: basename(path),
    matches: (name) => TEMPLATE.test(name),
    temporary: (name) => PARTIAL.test(name),
  });
}
