// The script a scaffolded app is set up by — `bun run setup` — written as TypeScript that Bun runs,
// never as shell. A bash `bin/setup` was the first thing a PowerShell or cmd user hit after `x new`,
// and it failed there. `bun run dev` and `bun run verify` need no file: they are `x dev` and
// `x verify`, and `x verify` builds what its budgets step weighs (no `bin/check`, plan 101 21).

import type { GeneratedFile } from './naming';

/** Where each script lands, and what the root `package.json`'s `scripts` run — named once. */
export const BIN_SCRIPTS = {
  setup: 'bin/setup.ts',
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

/** The bin scripts, in the order a newcomer runs them. */
export function binFiles(): readonly GeneratedFile[] {
  return [{ path: BIN_SCRIPTS.setup, contents: binSetup() }];
}
