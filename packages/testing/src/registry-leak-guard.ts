// Cross-file state pollution, caught at the boundary it crosses. `bun test` runs every file of one
// invocation in ONE process — only `--isolate` gives each file its own module registry — so a file
// that leaves a process-global registry dirty changes what every file after it sees, and the
// failure lands on an innocent suite in another package. This names the file that leaked.

import { afterAll, beforeEach } from 'bun:test';
import { knownTags, registeredTiers } from '@ultimat3/cache';
import { UltimateError } from '@ultimat3/core';

/**
 * What is guarded, and why only these two. Both are BOOT installs — `declareTags` takes the
 * manifest's entity names, `registerTier` takes `app.config.ts`'s tiers — so "empty again when the
 * file ends" is the honest invariant for a test. The entity, job, route and permission registries
 * are not here: `entity()` and `job()` register at module scope, which is how an app declares
 * itself, so a file that leaves them filled is idiomatic rather than leaky. A test whose subject is
 * an EMPTY one of those establishes it itself — `isolateEntityRegistry()`.
 */
export interface RegistrySample {
  readonly tags: readonly string[];
  readonly tiers: readonly string[];
}

export interface RegistryLeak {
  /** Repo-relative when it can be, so the message names the file an editor opens. */
  readonly file: string;
  readonly tags: readonly string[];
  readonly tiers: readonly string[];
}

export function sampleRegistries(): RegistrySample {
  return { tags: [...knownTags()], tiers: registeredTiers().map((tier) => tier.name) };
}

/**
 * Additions only. A file that DROPS a tier a previous file registered is a different bug and not
 * this one's to report — reporting both here would make the message ambiguous about which file to
 * open.
 */
export function leakBetween(
  file: string,
  before: RegistrySample,
  after: RegistrySample,
): RegistryLeak | undefined {
  const tags = after.tags.filter((name) => !before.tags.includes(name));
  const tiers = after.tiers.filter((name) => !before.tiers.includes(name));
  if (tags.length === 0 && tiers.length === 0) return undefined;
  return { file, tags, tiers };
}

const describeLeak = (leak: RegistryLeak): string => {
  const left = [
    ...(leak.tags.length > 0 ? [`cache tags declared (${leak.tags.join(', ')})`] : []),
    ...(leak.tiers.length > 0 ? [`cache tiers registered (${leak.tiers.join(', ')})`] : []),
  ];
  return `${leak.file} left ${left.join(' and ')} after its last test`;
};

const fixFor = (leak: RegistryLeak): string => {
  const calls = [
    ...(leak.tags.length > 0 ? ['const restore = isolateDeclaredTags(); afterAll(restore)'] : []),
    ...(leak.tiers.length > 0 ? ['afterAll(resetTiers)'] : []),
  ];
  return `${calls.join(' and ')} in ${leak.file}`;
};

/**
 * One error for every leaker in the run, not one per file: the run has already finished by the
 * time the last file can be judged, and two throws would report the second as an unhandled one.
 */
export class RegistryLeakError extends UltimateError {
  constructor(input: { readonly leaks: readonly RegistryLeak[] }) {
    super({
      code: 'X_TEST_REGISTRY_LEAK',
      cause: input.leaks.map(describeLeak).join('; '),
      fix: input.leaks.map(fixFor).join('; '),
      docs: 'https://ultimate.dev/errors/X_TEST_REGISTRY_LEAK',
    });
  }
}

/** `Bun.file(path).text()` answers an absolute path; the message wants the one a reader types. */
const repoRelative = (path: string): string => {
  const root = `${process.cwd()}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
};

let installed = false;

/**
 * Called by the test preload, once per process. Idempotent because two preloads reaching it would
 * otherwise register the hooks twice and report every leak twice.
 *
 * Under `--isolate` each file gets its own module registry, so the guard judges that one file and
 * nothing carries across — which is correct, not a hole: with `--isolate` there is no cross-file
 * pollution to find, and a file that leaks is still reported against itself.
 */
export function installRegistryLeakGuard(): void {
  if (installed) return;
  installed = true;

  let pending: string | undefined;
  let current: { readonly file: string; readonly before: RegistrySample } | undefined;
  const leaks: RegistryLeak[] = [];

  const close = (): void => {
    if (current === undefined) return;
    const leak = leakBetween(current.file, current.before, sampleRegistries());
    if (leak !== undefined) leaks.push(leak);
    current = undefined;
  };

  // The only signal Bun gives a preload for "a new test file starts": its hooks carry no file. A
  // load handler MUST answer with contents — one that answers `undefined` makes Bun load nothing
  // for the file and the run reports zero tests, silently.
  Bun.plugin({
    name: 'ultimate-registry-leak-guard',
    setup(build) {
      build.onLoad({ filter: /\.test\.tsx?$/ }, async (args) => {
        close();
        pending = repoRelative(args.path);
        return {
          contents: await Bun.file(args.path).text(),
          loader: args.path.endsWith('tsx') ? 'tsx' : 'ts',
        };
      });
    },
  });

  // The baseline is taken here rather than in the load handler on purpose: everything a file's
  // MODULE graph registers is its environment — importing an app module is how an app declares its
  // tags — and the first `beforeEach` is the earliest point at which that graph has finished
  // evaluating. What the guard judges is what the file's TESTS install.
  beforeEach(() => {
    if (pending === undefined) return;
    current = { file: pending, before: sampleRegistries() };
    pending = undefined;
  });

  afterAll(() => {
    close();
    if (leaks.length > 0) throw new RegistryLeakError({ leaks });
  });
}
