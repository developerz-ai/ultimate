// Flag parsing for the root scripts. Deliberately smaller than the CLI's parser: scripts take a
// handful of flags and must not grow a command tree — that is what `x` is for.

import { report } from './log';
import { insideRoot, toPosix } from './posix-path';
import { repoRoot } from './run';
import { ScriptError } from './script-error';

export interface ScriptArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly json: boolean;
  /** The words as typed, so a refusal can hand back the corrected command rather than a sentence. */
  readonly argv: readonly string[];
}

/** A word that is one shell word as written — the only kind a refusal splices into its `fix:`. */
const INERT = /^[\w./:@,=+-]+$/;
/** A value the typist meant as OFF. The corrected command drops the flag rather than enabling it. */
const OFF = /^(?:false|0|no|off)$/i;

/**
 * The script being run, repo-relative and `/`-spelt — what `bun run` takes on every host — and
 * single-quoted unless inert. Compared `/`-normalised: on Windows `Bun.main` is `D:\…\x.ts`,
 * a `${root}/` prefix never matched, and the fix pasted back the absolute, quoted path.
 */
export const scriptPathOf = (main: string, root: string): string => {
  const path = insideRoot(root, main) ?? main;
  return INERT.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
};

/** The script's name, as a JSON document's `script` names it: its file name, no extension. */
export const scriptNameOf = (main: string): string =>
  (toPosix(main).split('/').at(-1) || 'script').replace(/\.ts$/, '');

const scriptPath = (): string => scriptPathOf(Bun.main, repoRoot());

/**
 * The same invocation with `--<name>` spelled as a boolean: `--name=true` / `--name true` become
 * `--name`, an OFF value drops it, and any other word (`--json merge`) moves in front of the flag,
 * where it is the positional it was meant to be. Any word that is not shell-inert reduces the fix to
 * the bare flag, so nothing a caller typed is pasted back unscreened.
 */
function corrected(argv: readonly string[], name: string, value: string): string {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? '';
    const glued = word === `--${name}=${value}`;
    if (!glued && word !== `--${name}`) {
      out.push(word);
      continue;
    }
    if (!glued) index += 1;
    if (OFF.test(value)) continue;
    if (!glued && !/^(?:true|1|yes|on)$/i.test(value)) out.push(value);
    out.push(`--${name}`);
  }
  const words = out.every((word) => INERT.test(word)) ? out : [`--${name}`];
  return ['bun', 'run', scriptPath(), ...words].join(' ').trimEnd();
}

/** `argv` IS this process's own — what every script hands in, never a test's literal array. */
const ownArgv = (argv: readonly string[]): boolean =>
  argv.length === Bun.argv.length - 2 && argv.every((word, index) => word === Bun.argv[index + 2]);

/** Asked for JSON: a bare `--json`, or `--json=<anything but an OFF value>`. */
const wantsJson = (argv: readonly string[]): boolean =>
  argv.some(
    (word) => word === '--json' || (word.startsWith('--json=') && !OFF.test(word.slice(7))),
  );

const refuseValue = (argv: readonly string[], name: string, value: string): never => {
  const refusal = new ScriptError({
    code: 'X_CLI_BAD_FLAG',
    cause: `--${name} is a boolean flag and was given a value (${INERT.test(value) ? value : 'a word that is not one shell word'}) — read as a boolean it would have meant OFF, and a dry run that runs for real is the failure this refuses`,
    fix: corrected(argv, name, value),
  });
  // The script's own command line: answered like any other finding — one JSON document under
  // `--json`, the three-line form otherwise — never an uncaught stack trace a `--json` reader
  // cannot parse. Any other caller (a test, a wrapper) gets the throw.
  if (!ownArgv(argv)) throw refusal;
  const script = scriptNameOf(Bun.main);
  return report(
    { ok: false, script, summary: 'refused', findings: [refusal.toFinding()] },
    wantsJson(argv),
  );
};

export function parseScriptArgs(argv: readonly string[]): ScriptArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    index += 1;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
      continue;
    }
    flags.set(body, true);
  }
  // `--json` is boolean in every script, so it is refused here rather than per caller.
  const json = flags.get('json');
  if (typeof json === 'string') refuseValue(argv, 'json', json);
  return { positionals, flags, json: json === true, argv };
}

export const flagString = (args: ScriptArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** True for a bare `--name`, false when absent — and `X_CLI_BAD_FLAG` when it was given a value. */
export const flagBool = (args: ScriptArgs, name: string): boolean => {
  const value = args.flags.get(name);
  if (typeof value === 'string') return refuseValue(args.argv, name, value);
  return value === true;
};

export const flagList = (args: ScriptArgs, name: string): readonly string[] =>
  (flagString(args, name) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
