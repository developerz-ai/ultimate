// Cross-file state pollution, caught at the boundary it crosses and — where a registry can be put
// back — repaired there. `bun test` runs one invocation in ONE process, so a file that leaves a
// process-global registry dirty changes what every file after it sees and the failure lands on an
// innocent suite in another package. What is REPORTED and what is RESTORED are disjoint sets.

import { afterAll } from 'bun:test';
import { knownTags, registeredTiers } from '@ultimat3/cache';
import { RegistryLeakError } from './errors';
import type { ProcessRegistrySnapshot } from './registry-snapshot';
import { captureProcessRegistries, restoreProcessRegistries } from './registry-snapshot';

/**
 * What is REPORTED, and why only these two. Both are BOOT installs — `declareTags` takes the
 * manifest's entity names, `registerTier` takes `app.config.ts`'s tiers — so "empty again when the
 * file ends" is the honest invariant for a test. The entity, job, route and permission registries
 * are not here: `entity()` and `job()` register at module scope, which is how an app declares
 * itself, so a file that leaves them filled is idiomatic rather than leaky. A test whose subject is
 * an EMPTY one of those establishes it itself — `isolateEntityRegistry()`.
 *
 * Neither is RESTORED, and that is the same judgement read the other way: `@ultimat3/cache`
 * publishes no un-declare for a tag, so there is nothing to put a tag registry back WITH. The
 * registries that are restored are `registry-snapshot.ts`'s, and none of them is reported —
 * repairing a state and then failing the run over it would be two answers to one question.
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

/** `Bun.file(path).text()` answers an absolute path; the message wants the one a reader types. */
const repoRelative = (path: string): string => {
  const root = `${process.cwd()}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
};

/**
 * The one point at which a file's baseline is honest, and the reason it is not a hook. Measured on
 * Bun 1.3.14 with a `Bun.plugin` load handler and hooks at every scope, the order is:
 *
 *   onLoad → module eval → file `beforeAll` → describe `beforeAll` → preload `beforeEach` → test
 *
 * A preload's `beforeEach` therefore runs AFTER the file's own `beforeAll`, so a `declareTags()`
 * there landed in the baseline and the file read clean — a false green in the guard whose entire
 * job is catching false greens. Appending the sample to the file's own source is what puts it
 * after module evaluation (its environment) and before the first hook the file registers (its own
 * doing). `bun:test` hooks carry no file identity; this loader does.
 */
const BASELINE_HOOK = '__ultimateRegistryLeakBaseline';

/** Appended, never prepended: an `import` is hoisted and would sample before the graph evaluates. */
const SAMPLE_BASELINE = `\n;globalThis[${JSON.stringify(BASELINE_HOOK)}]?.();\n`;

const hookHost = globalThis as typeof globalThis & { [BASELINE_HOOK]?: () => void };

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
  let current:
    | {
        readonly file: string;
        readonly before: RegistrySample;
        readonly snapshot: ProcessRegistrySnapshot;
      }
    | undefined;
  const leaks: RegistryLeak[] = [];

  const close = (): void => {
    if (current === undefined) return;
    const leak = leakBetween(current.file, current.before, sampleRegistries());
    if (leak !== undefined) leaks.push(leak);
    // The repair, at the only point it is safe: the file is over and the next one has not
    // evaluated yet, so what goes back is exactly what that file inherited — module-scope
    // declarations included, which is the half a plain `resetX()` in a `beforeEach` destroys.
    restoreProcessRegistries(current.snapshot);
    current = undefined;
  };

  // Called by the statement appended below, once per test file, from that file's own module scope:
  // everything the file's MODULE graph registered is its environment — importing an app module is
  // how an app declares its tags — and everything after this point is the file's own to undo.
  hookHost[BASELINE_HOOK] = () => {
    if (pending === undefined) return;
    current = {
      file: pending,
      before: sampleRegistries(),
      snapshot: captureProcessRegistries(),
    };
    pending = undefined;
  };

  // The only signal Bun gives a preload for "a new test file starts": its hooks carry no file. A
  // load handler MUST answer with contents — one that answers `undefined` makes Bun load nothing
  // for the file and the run reports zero tests, silently.
  Bun.plugin({
    name: 'ultimate-registry-leak-guard',
    setup(build) {
      // `.test.ts` only, never `.test.tsx`. A load handler that answered `loader: 'tsx'` would
      // compile JSX with Bun's CLASSIC React fallback — the very factory `@ultimat3/render`'s own
      // loader exists to replace — and, because the first matching handler wins and this one is
      // registered from the preload, it would shadow render's transform for that file. Routing
      // `.tsx` through `transformTsx` is not the alternative either: it needs `@ultimat3/render`,
      // whose import installs that global loader into every test process in the repo. Zero
      // `.test.tsx` files exist and the convention is `<file>.test.ts`, so the narrower filter
      // costs nothing today; a `.test.tsx` added later is unguarded rather than mis-compiled.
      build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
        close();
        pending = repoRelative(args.path);
        return {
          contents: `${await Bun.file(args.path).text()}${SAMPLE_BASELINE}`,
          loader: 'ts',
        };
      });
    },
  });

  afterAll(() => {
    close();
    if (leaks.length > 0) throw new RegistryLeakError({ leaks });
  });
}
