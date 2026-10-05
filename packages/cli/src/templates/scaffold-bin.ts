// The two scripts a scaffolded app is driven by — `bun run setup` and `bun run check` — written as
// TypeScript that Bun runs, never as shell. A bash `bin/setup` was the first thing a PowerShell or
// cmd user hit after `x new`, and it failed there; a `.ts` file run by the Bun the app already
// requires is the same script on every OS. `bun run dev` needs no file: it is `x dev`.

import type { GeneratedFile } from './naming';

/** Where each script lands, and what the root `package.json`'s `scripts` run — named once. */
export const BIN_SCRIPTS = {
  setup: 'bin/setup.ts',
  check: 'bin/check.ts',
} as const;

/** The `package.json` script line that runs a bin file: Bun itself, so no shell interprets it. */
export const binScript = (path: string): string => `bun ${path}`;

// Every step is a TOP-LEVEL call statement, one per line — `scripts/setup-commands.ts` reads the
// documented sequence out of exactly those lines, so a helper's body (indented) or the closing
// `console.log` (a member call) is never mistaken for a step. `bun x x` is `bunx x` spelled through
// the running Bun's own path: no PATH lookup, so no shell or PATHEXT decides which `x` runs.
const binSetup =
  (): string => `// Fresh clone to running. Idempotent: safe to re-run. \`bun run setup\` — Bun runs this file, so
// it is the same script under PowerShell, cmd or any POSIX shell.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** One step, from the app root, on this terminal. A red step ends setup with its own exit code. */
const run = async (argv: readonly string[]): Promise<void> => {
  const code = await Bun.spawn([...argv], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
    .exited;
  if (code !== 0) process.exit(code);
};

/** Bun itself, by the path it is running from. */
const bun = (...args: string[]): Promise<void> => run([process.execPath, ...args]);

/** The app's own CLI, as \`bunx x\` resolves it — the install below links it into node_modules. */
const x = (...args: string[]): Promise<void> => run([process.execPath, 'x', 'x', ...args]);

/** Writes a file only when it is absent, so a re-run never clobbers what a box put there. */
const ensureFile = (path: string, contents: string): void => {
  if (!existsSync(join(root, path))) writeFileSync(join(root, path), contents);
};

const PER_BOX = '# per-box secrets, gitignored, wins over .env.development\\n';

// \`x db gen\` is the ONE writer of packages/db/migrations — the scaffold no longer hand-writes a
// 0000_initial.sql, because a second writer is how the source and the ledger ended up disagreeing
// about what "initial" meant. Guarded on the directory rather than on the generator being a no-op:
// this script is documented idempotent, and the guard is what makes that true here.
const hasMigration = (): boolean => {
  const dir = join(root, 'packages', 'db', 'migrations');
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.sql'));
};

await bun('install');
ensureFile('.env.development.local', PER_BOX);
if (!hasMigration()) await x('db', 'gen', 'initial');
await x('db', 'migrate', ...process.argv.slice(2));
// \`x db seed\`, never a plain script: the CLI owns the connection, so this reaches the same
// embedded PGlite the migration above just wrote to. A plain script goes through \`db()\`, which
// needs a \`postgres:\` DATABASE_URL and so dies on a clone with no Postgres.
await x('db', 'seed');
// The file AGENTS.md tells an agent facts live in, and \`x dev\` prints the path of. It is a
// projection of the loaded app, so \`x new\` cannot write it — node_modules does not exist yet.
// \`x verify\`'s manifest step refuses its absence (X_MANIFEST_MISSING).
await x('manifest');
console.log('setup complete — next: bun run dev');
`;

const binCheck =
  (): string => `// The gate. Same steps as CI, because a check that lives only in CI cannot be run locally.
// \`bun run check\` — Bun runs this file, so it is the same gate under PowerShell, cmd or bash.
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);

/** The app's own CLI, as \`bunx x\` resolves it, from the app root; resolves to its exit code. */
const x = async (...argv: string[]): Promise<number> => {
  const child = Bun.spawn([process.execPath, 'x', 'x', ...argv], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  // The terminal already hands Ctrl-C to the child; this process only waits for its verdict. A
  // SIGTERM is forwarded, so a CI timeout stops the gate instead of orphaning it mid-step.
  const wait = (): void => {};
  const stop = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', wait);
  process.on('SIGTERM', stop);
  const code = await child.exited;
  process.off('SIGINT', wait);
  process.off('SIGTERM', stop);
  return code;
};

// The build FIRST, and not as a convenience: \`x verify\`'s budgets step compares declared limits
// against measured bytes in .x/build-stats.json, so with no build it reports X_BUDGET_UNMEASURED
// and the very first gate anyone runs on a brand-new app is red for a reason that has nothing to
// do with their code.
//
// \`--json\` is forwarded to BOTH, or the contract breaks: the build's human renderer followed by
// the gate's JSON is neither on stdout. Both commands emit one object; a reader takes the last line.
// \`--no-preflight\`: the build's own preflight is x verify's first six steps (typecheck, lint,
// boundaries, filesize, package-shape, errors), and the gate below runs them anyway.
const json = args.some((arg) => arg === '--json' || arg === '-j') ? ['--json'] : [];
const built = await x('build', '--target', 'static', '--no-preflight', ...json);
if (built !== 0) process.exit(built);
process.exit(await x('verify', ...args));
`;

/** The bin scripts, in the order a newcomer runs them. */
export function binFiles(): readonly GeneratedFile[] {
  return [
    { path: BIN_SCRIPTS.setup, contents: binSetup() },
    { path: BIN_SCRIPTS.check, contents: binCheck() },
  ];
}
