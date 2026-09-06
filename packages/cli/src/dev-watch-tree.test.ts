// The watch SET, not the event filter. Measured on `x dev` against `examples/dummy`: 110 inotify
// descriptors, one per directory in the tree, 39 of them under `.x/` and `node_modules/` — and on a
// monorepo root 1901, of which 1490 were `.git/` and `node_modules/`. The filter answered
// correctly every time; the cost was that the kernel and the JS callback had already run.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no directory-create, file-write or recursive-remove primitive — `Bun.write`
// creates parents for a FILE only, and a fixture tree needs empty directories too. `readdirSync`
// and `readFileSync` read `/proc/self/fdinfo`, which is a kernel interface and not a Bun one.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { devIgnore } from './dev-watch';
import type { DirectoryWatcher, WatchListener } from './dev-watch-tree';
import { admittedDirectories, watchTree } from './dev-watch-tree';

/** Every directory the finding names, plus the one an app legitimately owns. */
function tree(name: string, gitignore?: string): string {
  const root = join(
    process.env['TMPDIR'] ?? '/tmp',
    `x-watch-tree-${name}-${process.pid}-${Bun.nanoseconds()}`,
  );
  for (const directory of [
    '.git/refs/heads',
    'node_modules/left-pad',
    '.x/pgdata',
    'coverage/lcov-report',
    'apps/web/site/coverage',
    'apps/web/app/feed',
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  // The marker stops the ignore walk here, so no ancestor of TMPDIR can decide a case below.
  if (gitignore !== undefined) writeFileSync(join(root, '.gitignore'), gitignore);
  return root;
}

/**
 * A watcher registry that records what was opened and what was closed, and can fire an event. The
 * seam is handed the ABSOLUTE directory, because that is what `fs.watch` takes; the keys here are
 * app-root-relative, because that is what every assertion below is written in.
 */
function fakeWatchers(root: string): {
  watchDirectory: (directory: string, listener: WatchListener) => DirectoryWatcher;
  open: Map<string, { closed: boolean; listener: WatchListener }>;
  fire: (directory: string, event: string, filename: string | null | undefined) => void;
} {
  const open = new Map<string, { closed: boolean; listener: WatchListener }>();
  return {
    open,
    watchDirectory: (absolute, listener) => {
      const entry = { closed: false, listener };
      open.set(absolute === root ? '' : absolute.slice(root.length + 1), entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
    fire: (directory, event, filename) => {
      const entry = open.get(directory);
      if (entry === undefined || entry.closed) {
        expect.unreachable(`no live watcher on ${JSON.stringify(directory)}`);
        return;
      }
      entry.listener(event, filename);
    },
  };
}

describe('admittedDirectories', () => {
  test('an ignored directory is never descended, and never watched', () => {
    const root = tree('walk', '/coverage/\n');
    expect(admittedDirectories(root, devIgnore(root))).toEqual([
      '',
      'apps',
      'apps/web',
      'apps/web/app',
      'apps/web/app/feed',
      'apps/web/site',
      // The app's OWN `/coverage` route: rooted `/coverage/` names the one at the top and this is
      // not it. Hand-listing `coverage` is what made this directory invisible to the dev loop.
      'apps/web/site/coverage',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('a descriptor is held for exactly the admitted set', () => {
    const root = tree('descriptors', '/coverage/\n');
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      onChange: () => undefined,
      watchDirectory: watchers.watchDirectory,
    });
    expect(handle.directories()).toEqual(admittedDirectories(root, devIgnore(root)));
    expect(watchers.open.size).toBe(handle.directories().length);
    handle.close();
    expect([...watchers.open.values()].every((entry) => entry.closed)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('watchTree', () => {
  test('a write under an ignored directory never reaches onChange', async () => {
    const root = tree('filter', '/coverage/\n*.tsbuildinfo\n');
    const seen: string[] = [];
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: (file) => seen.push(file),
      watchDirectory: watchers.watchDirectory,
    });
    // Every one of these arrives on the ROOT's own descriptor — which is the only one these
    // directories have, because none of them is watched.
    for (const name of ['.git', 'node_modules', '.x', 'coverage', 'tsconfig.tsbuildinfo']) {
      watchers.fire('', 'change', name);
    }
    watchers.fire('apps/web/app/feed', 'change', 'page.tsx');
    await Bun.sleep(20);
    expect(seen).toEqual(['apps/web/app/feed/page.tsx']);
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an app's own /coverage route still reloads", async () => {
    const root = tree('route', '/coverage/\n');
    const seen: string[] = [];
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: (file) => seen.push(file),
      watchDirectory: watchers.watchDirectory,
    });
    watchers.fire('apps/web/site/coverage', 'change', 'page.tsx');
    await Bun.sleep(20);
    expect(seen).toEqual(['apps/web/site/coverage/page.tsx']);
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a burst of writes is one reload, naming the last file', async () => {
    const root = tree('burst');
    const seen: string[] = [];
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 5,
      onChange: (file) => seen.push(file),
      watchDirectory: watchers.watchDirectory,
    });
    for (const name of ['a.tsx', 'b.tsx', 'c.tsx']) {
      watchers.fire('apps/web/app/feed', 'change', name);
    }
    await Bun.sleep(30);
    expect(seen).toEqual(['apps/web/app/feed/c.tsx']);
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  // `??` guards NULLISH and `NaN` is not nullish, so a `NaN` debounce walked straight past the
  // default into `setTimeout(fn, NaN)`, which coerces to 0: every keystroke a full `appManifest()`
  // plus `buildIslands()`, with the debounce reporting itself as installed. `Infinity` is the same
  // hole in the other direction — a reload that never fires. A coded refusal, never a clamp.
  test('a debounce that is not a whole number of milliseconds is refused', () => {
    const root = tree('debounce');
    for (const debounceMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const watchers = fakeWatchers(root);
      expect(() =>
        watchTree({
          root,
          debounceMs,
          onChange: () => undefined,
          watchDirectory: watchers.watchDirectory,
        }),
      ).toThrow('X_INVARIANT');
      // And it refuses BEFORE a descriptor is taken, or the throw leaks every watcher it opened.
      expect(watchers.open.size).toBe(0);
    }
    rmSync(root, { recursive: true, force: true });
  });

  // Reproduced: Bun's recursive watcher delivers `undefined` when the root is renamed or removed
  // (`mv myapp myapp2`, a re-clone, a volume remount). `isIgnoredPath(undefined)` threw a TypeError
  // inside an fs callback, outside any try, with no uncaughtException handler — `x dev` died.
  test('an event with no filename is survived, not thrown on', async () => {
    const root = tree('unnamed');
    const seen: string[] = [];
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: (file) => seen.push(file),
      watchDirectory: watchers.watchDirectory,
    });
    expect(() => watchers.fire('', 'rename', undefined)).not.toThrow();
    expect(() => watchers.fire('', 'rename', null)).not.toThrow();
    watchers.fire('apps/web/app/feed', 'change', 'page.tsx');
    await Bun.sleep(20);
    expect(seen).toEqual(['apps/web/app/feed/page.tsx']);
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a new directory is picked up and watched', async () => {
    const root = tree('new');
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: () => undefined,
      watchDirectory: watchers.watchDirectory,
    });
    expect(handle.directories()).not.toContain('apps/web/site/pricing');
    mkdirSync(join(root, 'apps/web/site/pricing/plans'), { recursive: true });
    watchers.fire('apps/web/site', 'rename', 'pricing');
    expect(handle.directories()).toContain('apps/web/site/pricing');
    // And its own children, or a page created two levels down after the mkdir is invisible.
    expect(handle.directories()).toContain('apps/web/site/pricing/plans');
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a removed directory gives its descriptor back', async () => {
    const root = tree('removed');
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: () => undefined,
      watchDirectory: watchers.watchDirectory,
    });
    expect(handle.directories()).toContain('apps/web/app/feed');
    rmSync(join(root, 'apps/web/app/feed'), { recursive: true, force: true });
    watchers.fire('apps/web/app', 'rename', 'feed');
    expect(handle.directories()).not.toContain('apps/web/app/feed');
    expect(watchers.open.get('apps/web/app/feed')?.closed).toBe(true);
    rmSync(root, { recursive: true, force: true });
    handle.close();
  });

  test('editing .gitignore re-reads it, and a newly ignored directory loses its watch', async () => {
    const root = tree('reread');
    mkdirSync(join(root, 'scratch/notes'), { recursive: true });
    const seen: string[] = [];
    const watchers = fakeWatchers(root);
    const handle = watchTree({
      root,
      debounceMs: 1,
      onChange: (file) => seen.push(file),
      watchDirectory: watchers.watchDirectory,
    });
    expect(handle.directories()).toContain('scratch/notes');
    writeFileSync(join(root, '.gitignore'), '/scratch/\n');
    watchers.fire('', 'change', '.gitignore');
    expect(handle.directories()).not.toContain('scratch');
    expect(handle.directories()).not.toContain('scratch/notes');
    expect(watchers.open.get('scratch')?.closed).toBe(true);
    watchers.fire('', 'change', 'scratch');
    await Bun.sleep(20);
    // The ignore file itself is not app source, so re-reading it is not a rebuild either.
    expect(seen).toEqual([]);
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The kernel's own answer, because everything above this point trusts an injected seam. A watcher
 * registered per directory is only cheaper if the descriptors really are not taken, and 110 of them
 * on the reference app — 39 under `.x/` and `node_modules/` — is what the seam cannot see.
 */
function inotifyWatchDescriptors(): number {
  let total = 0;
  for (const fd of readdirSync('/proc/self/fdinfo')) {
    try {
      total += readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('inotify wd')).length;
    } catch {
      // A file descriptor closed between the listing and the read. Not this process's watchers.
    }
  }
  return total;
}

const onLinux = process.platform === 'linux';

describe.skipIf(!onLinux)('watchTree · real descriptors', () => {
  test('the kernel holds one watch per admitted directory, and none for the rest', () => {
    const root = tree('inotify', '/coverage/\n');
    const before = inotifyWatchDescriptors();
    const handle = watchTree({ root, onChange: () => undefined });
    const held = inotifyWatchDescriptors() - before;
    // Six directories in the fixture are `.git/`, `node_modules/`, `.x/` and the git-ignored
    // `coverage/`; every one of them cost a descriptor under `{ recursive: true }`.
    expect(handle.directories()).toHaveLength(7);
    expect(held).toBe(7);
    handle.close();
    expect(inotifyWatchDescriptors()).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });
});
