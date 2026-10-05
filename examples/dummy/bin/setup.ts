// Fresh checkout → runnable app. Thin wrapper: `x setup` owns every step below. `bun run setup` —
// Bun runs this file, so it is the same script under PowerShell, cmd or any POSIX shell.
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
// .env from .env.example, embedded Postgres, migrate, seed 'dev'. Its JSON report is not for a
// human, so stdout is dropped; a failure still prints its finding on stderr.
await x('ignore', 'setup', '--json');
await x('inherit', 'verify');

console.log('postly ready — run bun run dev');
