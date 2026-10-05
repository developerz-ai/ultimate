// Fresh checkout → runnable app: install, `.env` from `.env.example`, migrate the embedded Postgres,
// seed 'dev', write the manifest, then the gate. `bun run setup` — Bun runs this file, so it is the
// same script under PowerShell, cmd or any POSIX shell. Idempotent: safe to re-run.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** One step, from the app root. A red step ends setup with its own exit code. */
const run = async (argv: readonly string[], stdout: 'inherit' | 'ignore'): Promise<void> => {
  const code = await Bun.spawn([...argv], { cwd: root, stdio: ['inherit', stdout, 'inherit'] })
    .exited;
  if (code !== 0) process.exit(code);
};

/** The app's own CLI, as `bunx x` resolves it — the install below links it into node_modules. */
const x = (stdout: 'inherit' | 'ignore', ...args: string[]): Promise<void> =>
  run([process.execPath, 'x', 'x', ...args], stdout);

await run([process.execPath, 'install'], 'inherit');
// Never over a `.env` a box already has: it may hold that box's own values.
if (!existsSync(join(root, '.env'))) copyFileSync(join(root, '.env.example'), join(root, '.env'));
await x('inherit', 'db', 'migrate');
await x('inherit', 'db', 'seed', 'dev');
// Its JSON report is not for a human, so stdout is dropped; a failure still prints on stderr.
await x('ignore', 'manifest', '--json');
await x('inherit', 'verify');

console.log('postly ready — run bun run dev');
