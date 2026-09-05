// A globally installed `x` defers to the app's own `@ultimat3/cli` when the two are different
// files. Measured 2026-09-05 in an app whose global `x` was a `bun link` of this checkout: the
// global CLI's `@ultimat3/entity` was a second module instance with an EMPTY registry, so `x g`,
// `x db gen` and `x manifest` wrote a manifest with zero entities and proposed dropping every
// table — silently, with a green exit code. The app's entities register into the instance under
// its `node_modules`; only the CLI under that same `node_modules` can see them. So the rule is the
// one `tsc` and `eslint` follow: the project-local binary wins, and the global one only says so.
//
// The same registry split is what turned `x verify` green over that app: `@ultimat3/policy`'s
// `isKnownPermission` deliberately checks nothing while no permission is declared, and the global
// CLI's instance had none declared — so the `policy` step that exists to refuse an undeclared
// grant (`app-permissions.ts`) had an empty set to refuse against. One process, one registry.

// why: `realpathSync` is the whole decision — Bun ships no symlink-resolving stat of its own, and
// `Bun.file(path).exists()` follows a link without saying where it went.
import { existsSync, realpathSync } from 'node:fs';
// why: Bun exposes no path-join primitive; the local bin is assembled from the app root.
import { join } from 'node:path';
import { findAppRoot } from './app-root';

/**
 * Set to any value to keep the CLI that was invoked. Nothing in this repository's CI needs it —
 * both tracked apps symlink `node_modules/@ultimat3/cli` to `packages/cli`, so the realpath test
 * below already answers "same file" — it exists for the one deliberate case: running a checkout's
 * CLI against an app that pins an older release, to see what the next release would say.
 */
export const KEEP_GLOBAL_CLI_ENV = 'ULTIMATE_KEEP_GLOBAL_CLI';

export const LOCAL_CLI_BIN = join('node_modules', '@ultimat3', 'cli', 'src', 'bin.ts');

export interface LocalCliIo {
  exists(path: string): boolean;
  realpath(path: string): string;
}

const nodeIo: LocalCliIo = {
  exists: existsSync,
  realpath: (path) => realpathSync(path),
};

/**
 * The app-local `bin.ts` to re-execute, or undefined when this process already IS the app's CLI
 * (a workspace symlink resolves to the same file), when there is no app, when this process is a
 * compiled binary, or when the caller opted out. Pure over the injected filesystem so the
 * decision has a test without a checkout.
 *
 * A compiled `x` (`x build --target binary`, the container's `/app/x`) has an `import.meta.path`
 * inside Bun's virtual `/$bunfs/` — no such file exists on disk, so `realpath` throws. That is
 * the keep case, not the hand-over case: the binary is the deliberate artifact, and the runtime
 * image carries no `bun` to hand over to. The other unresolvable side — a `node_modules` entry
 * that exists but whose link is dangling — is kept for the same reason: nothing there can run.
 */
export function resolveLocalCli(
  input: {
    readonly cwd: string;
    readonly selfPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  io: LocalCliIo = nodeIo,
): string | undefined {
  if (input.env[KEEP_GLOBAL_CLI_ENV] !== undefined) return undefined;
  const root = findAppRoot(input.cwd);
  if (root === undefined) return undefined;
  const local = join(root.dir, LOCAL_CLI_BIN);
  if (!io.exists(local)) return undefined;
  try {
    return io.realpath(local) === io.realpath(input.selfPath) ? undefined : local;
  } catch {
    return undefined;
  }
}
