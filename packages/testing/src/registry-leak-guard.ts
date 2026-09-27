// Cross-file state pollution, caught at the boundary it crosses and — where a registry can be put
// back — repaired there. `bun test` runs one invocation in ONE process, so a file that leaves a
// process-global registry dirty changes what every file after it sees and the failure lands on an
// innocent suite in another package. What is REPORTED and what is RESTORED are disjoint sets.

import { afterAll } from 'bun:test';
import { knownTags, registeredTiers } from '@ultimat3/cache';
import { isAppRoot } from './app-jsx-loader';
import { RegistryLeakError } from './errors';
import { runFileBoundary } from './file-boundary';
import type { ProcessRegistrySnapshot } from './registry-snapshot';
import {
  captureProcessRegistries,
  mergeSnapshots,
  restoreProcessRegistries,
} from './registry-snapshot';

/**
 * What is REPORTED, and why only these two. Both are BOOT installs — `declareTags` takes the
 * manifest's entity names, `registerTier` takes `app.config.ts`'s tiers — so "empty again when the
 * file ends" is the honest invariant for a test. The entity, job, route and permission registries
 * are not here: `entity()` and `job()` register at module scope, which is how an app declares
 * itself, so a file that leaves them FILLED is idiomatic rather than leaky. A test whose subject is
 * an EMPTY one of those establishes it itself — `isolateEntityRegistry()`.
 *
 * Neither is RESTORED, and for the tag registry that is the same judgement read the other way:
 * `@ultimat3/cache` publishes no un-declare, so there is nothing to put one back WITH. The
 * registries that are restored are `registry-snapshot.ts`'s, and none of them is reported —
 * repairing a state and then failing the run over it would be two answers to one question.
 *
 * **Filled and CLEARED are different questions, and the paragraph above only answers the first.**
 * "Idiomatic to leave filled" says nothing about a file that calls `clear*()`/`reset*()` and takes
 * a module-scope declaration from every file after it — a module evaluates once per process, so the
 * next file's own `import` is a cache hit that declares nothing. That is what `registry-snapshot.ts`
 * repairs, and it repairs FOUR registries out of the set that has one:
 *
 *   | registry | reset export | owner | in the snapshot? |
 *   |---|---|---|---|
 *   | locales / catalogs | `resetCatalogs` | `@ultimat3/i18n` | yes |
 *   | permissions / roles | `restorePermissions` / `restoreRoles` | `@ultimat3/policy` | yes |
 *   | routes | `clearRoutes` | `@ultimat3/render` | **no** |
 *   | jobs | `resetJobs` | `@ultimat3/jobs` | **no** |
 *   | tasks | `restoreTasks` | `@ultimat3/jobs` | yes (22.7) |
 *   | actions | `resetRegistry` | `@ultimat3/action` | **no** |
 *   | queries | `resetRegistry` | `@ultimat3/query` | **no** |
 *   | models / prompts / agents | `resetModels` / `resetPrompts` / `resetAgents` | `@ultimat3/ai` | **no** |
 *   | mails | `resetMails` | `@ultimat3/mail` | **no** |
 *   | entities | `clearRegistry` | `@ultimat3/entity` | no, by decision — `registry-isolation.ts` |
 *
 * Every "no" needs the SAME two halves the two "yes" rows have: a reader and a writer in the owning
 * package (`restorePermissions` was added to `@ultimat3/policy` for exactly this), and one line
 * here. `@ultimat3/jobs`, `@ultimat3/action`, `@ultimat3/query` and `@ultimat3/mail` publish a
 * lister and a reset but no restore, so the change is theirs first and this file's second — and it
 * has to land as ONE change, because the cost of the rest is a second edit of this same shape.
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
 * no REGISTRY state carries across — which is correct, not a hole: a file that leaks is still
 * reported against itself. MEMORY does carry across: on Bun 1.4.0 the plugin this registers keeps
 * every finished file's global object alive for the life of the worker (~57 MB per file measured).
 * `isolated-plugins.ts` clears the plugins after each isolated file.
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
  // Everything every earlier file inherited, merged: what a shared worker restores to.
  let accumulated: ProcessRegistrySnapshot | undefined;
  // The locale config before any app code ran — preload time.
  const pristineLocales = JSON.stringify(captureProcessRegistries().locales);
  const inApp = isAppRoot();

  const close = (): void => {
    if (current === undefined) return;
    const leak = leakBetween(current.file, current.before, sampleRegistries());
    if (leak !== undefined) leaks.push(leak);
    // The repair, at the only point it is safe: the file is over and the next one has not
    // evaluated yet, so what goes back is exactly what that file inherited — module-scope
    // declarations included, which is the half a plain `resetX()` in a `beforeEach` destroys.
    //
    // Declarations are put back as a UNION with what the process holds now (22.7, shared worker):
    // a module a test imported lazily declared its permissions and roles once, for the life of the
    // worker, and taking them away here would leave every later file without them. Tasks go back
    // EXACTLY: one a test body registered must not fire in the next file's scheduler round.
    const live = captureProcessRegistries();
    const merged = mergeSnapshots(live, current.snapshot);
    // Locales likewise, in one case: the file's baseline still held the framework's pristine
    // config and an app's `defineCatalogs()` ran during the file (a lazily imported catalog
    // module) — that configured the worker for good, since the module will not evaluate again.
    // A test that called `configureLocales()` by hand is undone, as before.
    // Only in an app: there `defineCatalogs()` can only be THE app's catalog module, while the
    // framework repository's own suites define a fixture app's catalogs per test, to be undone.
    const declaredLazily =
      inApp &&
      JSON.stringify(current.snapshot.locales) === pristineLocales &&
      live.catalogDeclarations > current.snapshot.catalogDeclarations;
    const restored = {
      ...merged,
      locales: declaredLazily ? live.locales : current.snapshot.locales,
      tasks: current.snapshot.tasks,
    };
    restoreProcessRegistries(restored);
    accumulated = mergeSnapshots(accumulated, restored);
    current = undefined;
  };

  // Called by the statement appended below, once per test file, from that file's own module scope:
  // everything the file's MODULE graph registered is its environment — importing an app module is
  // how an app declares its tags — and everything after this point is the file's own to undo.
  hookHost[BASELINE_HOOK] = () => {
    if (pending === undefined) return;
    accumulated = mergeSnapshots(accumulated, captureProcessRegistries());
    current = { file: pending, before: sampleRegistries(), snapshot: accumulated };
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
      // and the transform itself is on `@ultimat3/render/server`, whose import installs that global
      // loader into every test process in the repo. (The `.` barrel does NOT — `installRenderLoader()`
      // moved to `server.ts:15` in the 9.0.0 split, and this comment claimed otherwise until
      // 2026-08-23. The `server` half is still the one that would have to be imported.) Zero
      // `.test.tsx` files exist and the convention is `<file>.test.ts`, so the narrower filter
      // costs nothing today; a `.test.tsx` added later is unguarded rather than mis-compiled.
      build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
        // Before the registry restore: an island disposed here still needs its fake DOM.
        runFileBoundary();
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
