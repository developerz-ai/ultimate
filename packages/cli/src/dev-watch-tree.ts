// The app root watched one directory at a time, because the watch SET is a registration decision
// and not a filter. `watch(root, { recursive: true })` takes an inotify descriptor per directory
// in the tree — including every directory the dev loop then discards events from — so `.git/`,
// `node_modules/` and `.x/` (which this very process writes to, continuously) each cost a
// descriptor, a kernel queue entry and a JS callback per write, against a per-user descriptor
// budget of 8192 on many distributions. Bun 1.4.0's `fs.watch` takes no ignore option, so the
// only place the answer can be given early is at registration.

// why: Bun exposes no filesystem watcher, no directory listing and no synchronous stat —
// `Bun.file().exists()` is async and answers false for a DIRECTORY, which is the one thing this
// module has to decide. Delete each when Bun ships an equivalent.
import type { Dirent } from 'node:fs';
import { readdirSync, statSync, watch } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { finiteCount, logger } from '@ultimat3/core';
import type { DevIgnore } from './dev-watch';
import { devIgnore } from './dev-watch';
import { pathSegments } from './path-segments';

/** What `node:fs`'s watcher hands a listener — `filename` is optional in fact, not only in type. */
export type WatchListener = (event: string, filename: string | Buffer | null | undefined) => void;

/** The one thing this module needs of a watcher, so a test can stand one up in four lines. */
export interface DirectoryWatcher {
  close(): void;
}

export type WatchDirectory = (directory: string, listener: WatchListener) => DirectoryWatcher;

export interface WatchTreeOptions {
  readonly root: string;
  /** A source change, app-root-relative and POSIX-separated. Debounced. */
  readonly onChange: (file: string) => void;
  /** Trailing debounce. A save touching five files is one reload, not five. Default 30ms. */
  readonly debounceMs?: number;
  /** Test seam: the default is `node:fs`'s `watch(dir, { recursive: false })`. */
  readonly watchDirectory?: WatchDirectory;
}

export interface WatchTree {
  /** Directories holding a descriptor right now, app-root-relative; `''` is the app root. */
  directories(): readonly string[];
  close(): void;
}

const DEFAULT_DEBOUNCE_MS = 30;

/**
 * Every directory under `root` an event could be a source change in, `''` first. Ignored
 * directories are not descended, so a `node_modules` tree costs one `readdir` and nothing else.
 * A symlinked directory is deliberately not followed: `Dirent.isDirectory()` is false for one, and
 * a workspace symlink pointing back into the checkout would otherwise be walked twice.
 */
export function admittedDirectories(root: string, ignore: DevIgnore): readonly string[] {
  const admitted: string[] = [''];
  const pending: string[] = [''];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of childrenOf(join(root, next))) {
      if (!entry.isDirectory()) continue;
      const child = next === '' ? entry.name : `${next}/${entry.name}`;
      if (ignore.ignores(child, true)) continue;
      admitted.push(child);
      pending.push(child);
    }
  }
  return admitted.sort();
}

/**
 * One directory's entries, or none. A directory removed between the listing above and this read, or
 * one this user may not open, is neither a source change nor a finding anyone can act on.
 */
function childrenOf(path: string): readonly Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

const nodeWatch: WatchDirectory = (directory, listener) =>
  watch(directory, { recursive: false }, listener);

/** Whether the path is a directory right now — the question a `rename` event does not answer. */
function isDirectoryAt(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function watchTree(options: WatchTreeOptions): WatchTree {
  const { root, onChange } = options;
  // Screened before a single descriptor is taken. `??` guards NULLISH and `NaN` is not nullish, so
  // an unparsed value walks past the default into `setTimeout(fn, NaN)`, which coerces to **0**:
  // the debounce reads as installed and every keystroke runs a full `appManifest()` plus
  // `buildIslands()`. `0` is admitted — "rebuild on the next tick" is a decision — and `Infinity`
  // is not, because a reload that never fires is the same defect facing the other way.
  const debounceMs = finiteCount(
    'watchTree',
    'debounceMs',
    options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  );
  const open = new WatchDirectoryMap(options.watchDirectory ?? nodeWatch, root);
  let ignore = devIgnore(root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = '';
  let warned = false;

  const schedule = (file: string): void => {
    last = file;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => onChange(last), debounceMs);
  };

  const listen = (directory: string): void => {
    open.add(directory, (event, filename) => {
      if (typeof filename !== 'string' && !(filename instanceof Buffer)) {
        // Bun's watcher delivers no filename when the WATCHED directory itself moves or is removed
        // — `mv myapp myapp2`, a re-clone, a volume remount. Once, because the same rename can
        // arrive on every descriptor at the same instant.
        if (!warned) logger.warn('dev.watch.unnamed_event', { directory: directory || '.' });
        warned = true;
        return;
      }
      const name = pathSegments(filename.toString()).join('/');
      const file = directory === '' ? name : `${directory}/${name}`;
      // Asked of the DISK, once, because every trailing-slash rule in a `.gitignore` turns on it
      // and a `rename` says only that something moved. One stat against a whole rebuild.
      const isDirectory = open.has(file) || isDirectoryAt(join(root, file));
      if (event === 'rename') follow(file, isDirectory);
      if (file === '.gitignore') {
        // The ignore set is the app's own, so an edit to it changes which directories are watched
        // at all. Not a source change: rebuilding the manifest for it would be a reload the author
        // did not ask for on the one file whose whole job is saying what to leave alone.
        ignore = devIgnore(root);
        reconcile();
        return;
      }
      if (ignore.ignores(file, isDirectory)) return;
      schedule(file);
    });
  };

  /** A `rename` created or removed something: keep the descriptor set honest either way. */
  const follow = (file: string, isDirectory: boolean): void => {
    if (isDirectory && isDirectoryAt(join(root, file))) {
      if (ignore.ignores(file, true)) return;
      if (!open.has(file)) for (const found of subtree(file)) listen(found);
      return;
    }
    if (open.has(file)) open.remove(file);
  };

  /** The admitted directories at or under `directory`, discovered rather than assumed. */
  const subtree = (directory: string): readonly string[] =>
    admittedDirectories(join(root, directory), ignore).map((found) =>
      found === '' ? directory : `${directory}/${found}`,
    );

  /** The whole set, re-derived: a directory the author just ignored gives its descriptor back. */
  const reconcile = (): void => {
    const admitted = new Set(admittedDirectories(root, ignore));
    for (const held of open.directories()) if (!admitted.has(held)) open.remove(held);
    for (const directory of admitted) if (!open.has(directory)) listen(directory);
  };

  for (const directory of admittedDirectories(root, ignore)) listen(directory);

  return {
    directories: () => open.directories(),
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      open.closeAll();
    },
  };
}

/**
 * The descriptors this watcher holds, keyed by app-root-relative directory. Its own type because
 * removing one means removing everything under it: a deleted directory takes its children's
 * descriptors with it, and a `Map` iterated by the caller would leak every one of them.
 */
class WatchDirectoryMap {
  readonly #watchers = new Map<string, DirectoryWatcher>();
  readonly #watch: WatchDirectory;
  readonly #root: string;

  constructor(watchDirectory: WatchDirectory, root: string) {
    this.#watch = watchDirectory;
    this.#root = root;
  }

  add(directory: string, listener: WatchListener): void {
    if (this.#watchers.has(directory)) return;
    try {
      this.#watchers.set(directory, this.#watch(join(this.#root, directory), listener));
    } catch {
      // A directory that vanished between the walk and the registration. The parent's own
      // descriptor still reports anything that reappears there.
    }
  }

  has(directory: string): boolean {
    return this.#watchers.has(directory);
  }

  directories(): readonly string[] {
    return [...this.#watchers.keys()].sort();
  }

  remove(directory: string): void {
    for (const held of this.#watchers.keys()) {
      if (held !== directory && !held.startsWith(`${directory}/`)) continue;
      this.#watchers.get(held)?.close();
      this.#watchers.delete(held);
    }
  }

  closeAll(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
