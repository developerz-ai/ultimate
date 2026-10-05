// The `.env*` files of the APP ROOT, whatever directory `x` was started from. Bun auto-loads them
// from the process cwd only, while every command finds its root by walking up — so `x db migrate`
// run from `apps/web` found the app and none of its `.env`, and silently used the embedded
// database. Loaded once, after the root is known, never overriding a real environment variable.

import { isAbsolute, join, relative, resolve } from 'node:path'; // why: Bun ships no path join/resolve.
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

const QUOTES = new Set(['"', "'", '`']);

/**
 * The quoted value opening at `text[open]`, read the way Bun reads it: across lines until the first
 * unescaped closing quote, a backslash keeping the character after it (so `\"` never closes), and
 * only double quotes turning `\n` and `\r` into the characters. `undefined` when the quote never
 * closes — Bun then keeps the line as written, opening quote and all.
 */
function quoted(text: string, open: number): { value: string; end: number } | undefined {
  const quote = text[open];
  let value = '';
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === quote) return { value, end: at + 1 };
    if (char === '\\' && at + 1 < text.length) {
      const next = text[at + 1];
      value +=
        quote !== '"'
          ? `${char}${next}`
          : next === 'n'
            ? '\n'
            : next === 'r'
              ? '\r'
              : `${char}${next}`;
      at += 1;
      continue;
    }
    value += char;
  }
  return undefined;
}

/**
 * Bun's expansion pass, the one part of it reproduced: `\$` is a literal `$` in every kind of
 * value, quoted or not. Run after the quote pass, which is why `"a\\$x"` reads `a\$x` in Bun too.
 */
const literalDollars = (value: string): string => value.replaceAll('\\$', '$');

/**
 * A dotenv file, parsed to agree with Bun's own loader on the same bytes — a root `.env` must mean
 * the same thing whether Bun read it (the process started in the root) or this did (it started
 * below it). `KEY=value`, an optional `export `, `#` comments (an unquoted value ends at the first
 * `#`), values quoted with `"`, `'` or a backtick and free to span lines, so a PEM key parses. A
 * bare `\r` separates lines as `\n` does, inside a quoted value too.
 * Bun's `$VAR` expansion is NOT reproduced: it resolves lazily across every loaded file and the
 * process env, so a root default that needs one belongs in the process environment.
 */
export function parseDotenv(source: string): ReadonlyMap<string, string> {
  const text = source.replace(/\r\n?/g, '\n');
  const out = new Map<string, string>();
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const eol = newline === -1 ? text.length : newline;
    const line = text.slice(start, eol);
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*/.exec(line);
    const open = start + (match?.[0].length ?? 0);
    start = eol + 1;
    if (match === null) continue;
    const key = match[1] ?? '';
    const read = QUOTES.has(text[open] ?? '') ? quoted(text, open) : undefined;
    if (read !== undefined) {
      out.set(key, literalDollars(read.value));
      // Whatever follows the closing quote on its line is a comment to Bun.
      const after = text.indexOf('\n', read.end);
      start = after === -1 ? text.length : after + 1;
      continue;
    }
    const value = line.slice(match[0].length);
    const hash = value.indexOf('#');
    out.set(key, literalDollars((hash === -1 ? value : value.slice(0, hash)).trim()));
  }
  return out;
}

/** Where the command runs, and where the PROCESS started — not the same once `--cwd` is passed. */
export interface RootEnvInput {
  /** The `--cwd`-resolved directory the command works in; its app root is the one loaded. */
  readonly cwd: string;
  /** The directory the process started in: the only one whose `.env*` Bun loaded itself. */
  readonly processCwd: string;
  readonly env: Env;
}

/** Every `.env*` file in `dir`, merged in Bun's precedence for `envName`. */
async function envFilesIn(dir: string, names: readonly string[]): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  for (const name of names) {
    const file = Bun.file(join(dir, name));
    if (!(await file.exists())) continue;
    for (const [key, value] of parseDotenv(await file.text())) merged.set(key, value);
  }
  return merged;
}

/** True when `dir` is `root` or below it. */
const isWithin = (root: string, dir: string): boolean => {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** What one command's env owes the app root: keys to set, and another app's keys to remove. */
export interface RootEnvChanges {
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

/**
 * What the root's `.env*` files change in `env`. A real environment variable always wins. Nothing
 * when there is no app root or the process STARTED in the root (Bun loaded those files itself).
 * Judged against `processCwd`, never `cwd`: `x --cwd <app>` run from elsewhere resolves `cwd` to
 * the root, and Bun loaded the other directory's files, not the app's.
 *
 * What Bun loaded from the starting directory is not a real variable. Started below the root
 * (`apps/web`), it is the same app's own, more specific file, and it wins. Started OUTSIDE the
 * root — `x --cwd ../app-b db migrate` run in app-a — it is another app's: a key whose value is
 * exactly what that directory's files say is overridden by the target's, and REMOVED when the
 * target does not define it — left in place, app-a's DATABASE_URL migrated app-b, which relies on
 * its default. A value that differs from the file is one Bun did not write (it never overrides a
 * real variable), so it is real and stays.
 */
export async function rootEnvChanges(input: RootEnvInput): Promise<RootEnvChanges> {
  const { env } = input;
  const root = findAppRoot(input.cwd);
  if (root === undefined || resolve(root.dir) === resolve(input.processCwd)) {
    return { set: {}, unset: [] };
  }
  const envName = env['NODE_ENV'] ?? 'development';
  const merged = await envFilesIn(root.dir, rootEnvFiles(envName));
  // A superset of what Bun loads from a cwd, so a key from any of them is recognised as file-made.
  const foreign = isWithin(root.dir, input.processCwd)
    ? new Map<string, string>()
    : await envFilesIn(input.processCwd, [...rootEnvFiles(envName), '.env.local']);
  const fromFile = (key: string): boolean => foreign.has(key) && env[key] === foreign.get(key);
  return {
    set: Object.fromEntries([...merged].filter(([key]) => env[key] === undefined || fromFile(key))),
    unset: [...foreign.keys()].filter((key) => fromFile(key) && !merged.has(key)).sort(),
  };
}

type MutableEnv = Record<string, string | undefined>;

/**
 * The env a command runs with. When `env` IS the process env, it is changed in place — a package
 * reading `Bun.env` directly must see what the command sees, and an unset key must be GONE, not
 * merely shadowed. An injected env is never mutated: the command gets a rebuilt copy.
 */
export function applyRootEnv(
  env: Env,
  changes: RootEnvChanges,
  processEnv: MutableEnv = Bun.env,
): Env {
  if (env === processEnv) {
    for (const key of changes.unset) delete processEnv[key];
    Object.assign(processEnv, changes.set);
    return processEnv;
  }
  const rebuilt: MutableEnv = { ...env, ...changes.set };
  for (const key of changes.unset) delete rebuilt[key];
  return rebuilt;
}
