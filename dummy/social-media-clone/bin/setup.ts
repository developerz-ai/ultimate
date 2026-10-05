// Fresh clone to running. Idempotent: safe to re-run. `bun run setup` — Bun runs this file, so it
// is the same script under PowerShell, cmd or any POSIX shell.
import { existsSync, writeFileSync } from 'node:fs';
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

/** The app's own CLI, as `bunx x` resolves it — the install below links it into node_modules. */
const x = (...args: string[]): Promise<void> => run([process.execPath, 'x', 'x', ...args]);

/** Writes a file only when it is absent, so a re-run never clobbers what a box put there. */
const ensureFile = (path: string, contents: string): void => {
  if (!existsSync(join(root, path))) writeFileSync(join(root, path), contents);
};

await bun('install');
ensureFile('.env.development.local', '# per-box secrets, gitignored, wins over .env.development\n');
await x('db', 'migrate', ...process.argv.slice(2));
await bun('run', 'db:seed');
console.log('setup complete — next: bun run dev');
