// What `x docs` reads: every framework package the installed CLI can see, and the wiki its tarball
// ships. Two scope directories, because Bun's isolated layout puts only an app's DIRECT
// dependencies under its own `node_modules/@ultimat3`: measured on a fresh install, `x docs` saw one
// package of 28 and answered "nothing" for `upload a file to s3`.

// why: Bun ships no path module and no synchronous existence check for a path.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DocEntry } from '@ultimat3/manifest';
import { scanInstalledDocs, scanWikiDocs } from '@ultimat3/manifest';
import { posixRelative } from './posix-path';

/** This CLI's own package directory: `src/` is where every module of it lives, installed or not. */
export const cliPackageDir = (): string => dirname(import.meta.dir);

/**
 * The wiki pages beside this CLI. Installed, `prepack` copied them into the tarball's `wiki/`; in
 * this repository they are the checkout's own `wiki/`, two directories up from `packages/cli`, and
 * nothing is copied. `Home.md` is the page every wiki has, so its absence means no wiki at all.
 */
export function wikiDirFor(cliDir: string): string | undefined {
  const shipped = join(cliDir, 'wiki');
  if (existsSync(join(shipped, 'Home.md'))) return shipped;
  // Two up is the repository root only when it holds THIS `packages/cli`. Installed, two up from
  // `node_modules/@ultimat3/cli` is `node_modules/`, and an npm package named `wiki` is not ours.
  const root = join(cliDir, '..', '..');
  if (!isSameDir(join(root, 'packages', 'cli'), cliDir)) return undefined;
  const checkout = join(root, 'wiki');
  return existsSync(join(checkout, 'Home.md')) ? checkout : undefined;
}

const isSameDir = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** Where the shipped wiki is, and the CLI version it shipped in: what a wiki entry is dated by. */
export interface WikiSource {
  readonly dir: string;
  /** `dir` relative to the CLI package: what a hit's `source` is written against. */
  readonly relative: string;
  readonly version: string;
}

export interface DocsCorpus {
  readonly entries: readonly DocEntry[];
  /** `undefined` when the install ships no wiki — reported by the caller, never silently empty. */
  readonly wiki: WikiSource | undefined;
}

async function versionOf(cliDir: string): Promise<string> {
  const file = Bun.file(join(cliDir, 'package.json'));
  if (!(await file.exists())) return '';
  const parsed: unknown = await file.json().catch(() => undefined);
  const version: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  return typeof version === 'string' ? version : '';
}

export async function wikiSource(
  cliDir: string = cliPackageDir(),
): Promise<WikiSource | undefined> {
  const dir = wikiDirFor(cliDir);
  if (dir === undefined) return undefined;
  // Forward slashes on every OS: `source` is printed and pasted, never handed back to `join`.
  const fromCli = posixRelative(cliDir, dir);
  return { dir, relative: fromCli, version: await versionOf(cliDir) };
}

/**
 * The app's own scope first, then the CLI's: the CLI's store entry holds the CLI and every package
 * it depends on, and the app's adds the ones only the app installed (`ui`, `scraping`). A package
 * in both is read once, from the app's, which is the copy the app runs.
 */
export async function loadDocs(
  appScope: string,
  cliDir: string = cliPackageDir(),
): Promise<DocsCorpus> {
  const seen = new Set<string>();
  const entries: DocEntry[] = [];
  for (const scope of new Set([appScope, dirname(cliDir)])) {
    const scanned = await scanInstalledDocs(scope);
    entries.push(...scanned.filter((entry) => !seen.has(entry.package)));
    for (const entry of scanned) seen.add(entry.package);
  }
  const wiki = await wikiSource(cliDir);
  if (wiki !== undefined) {
    entries.push(
      ...(await scanWikiDocs(wiki.dir, {
        package: '@ultimat3/cli',
        version: wiki.version,
        dir: wiki.relative,
      })),
    );
  }
  return { entries, wiki };
}
