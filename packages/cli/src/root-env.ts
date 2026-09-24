// The `.env*` files of the APP ROOT, whatever directory `x` was started from. Bun auto-loads them
// from the process cwd only, while every command finds its root by walking up — so `x db migrate`
// run from `apps/web` found the app and none of its `.env`, and silently used the embedded
// database. Loaded once, after the root is known, never overriding a variable already set.

import { isAbsolute, join, resolve } from 'node:path'; // why: Bun ships no path join/resolve.
import { findAppRoot } from './app-root';

type Env = Readonly<Record<string, string | undefined>>;

/** `--cwd <dir>` / `--cwd=<dir>` from raw argv, resolved against `cwd` — for the hand-over. */
export function cwdFromArgv(argv: readonly string[], cwd: string): string {
  const at = argv.findIndex((token) => token === '--cwd' || token.startsWith('--cwd='));
  if (at === -1) return cwd;
  const token = argv[at] ?? '';
  const value = token.startsWith('--cwd=') ? token.slice('--cwd='.length) : argv[at + 1];
  if (value === undefined || value === '') return cwd;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** The files Bun itself would load at the root, lowest precedence first. */
export const rootEnvFiles = (envName: string): readonly string[] => [
  '.env',
  `.env.${envName}`,
  `.env.${envName}.local`,
];

/**
 * One dotenv line: `KEY=value`, an optional `export `, a `#` comment, a value in single or double
 * quotes (double quotes read `\n`). No `${VAR}` expansion — a root-level default that needs one
 * belongs in the process environment, which always wins here anyway.
 */
export function parseDotenv(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = (match[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      const inner = value.slice(1, value.lastIndexOf(quote));
      out.set(match[1] ?? '', quote === '"' ? inner.replaceAll('\\n', '\n') : inner);
    } else {
      out.set(match[1] ?? '', value.replace(/\s+#.*$/, ''));
    }
  }
  return out;
}

/**
 * The variables the root's `.env*` files add to `env`: only keys `env` does not already hold, so a
 * real environment variable — and anything Bun already loaded from the cwd — always wins. Empty
 * when there is no app root or the cwd IS the root (Bun loaded those files itself).
 */
export async function rootEnvAdditions(cwd: string, env: Env): Promise<Record<string, string>> {
  const root = findAppRoot(cwd);
  if (root === undefined || resolve(root.dir) === resolve(cwd)) return {};
  const merged = new Map<string, string>();
  for (const name of rootEnvFiles(env['NODE_ENV'] ?? 'development')) {
    const file = Bun.file(join(root.dir, name));
    if (!(await file.exists())) continue;
    for (const [key, value] of parseDotenv(await file.text())) merged.set(key, value);
  }
  return Object.fromEntries([...merged].filter(([key]) => env[key] === undefined));
}
