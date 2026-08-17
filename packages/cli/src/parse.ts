// Argument parsing for the whole `x` binary — one parser, so every command accepts flags the
// same way and `--json` / `--help` behave identically everywhere. Pure: no I/O, no process
// access, so the parser is unit-testable and the dispatcher owns all side effects.

import { BadFlagError, MissingSubcommandError, UnknownCommandError } from './errors';

export type FlagValue = string | boolean;

export interface FlagSpec {
  readonly name: string;
  readonly type: 'boolean' | 'string';
  readonly summary: string;
  readonly short?: string;
  readonly default?: FlagValue;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly aliases?: readonly string[];
  readonly subcommands?: readonly string[];
  /**
   * What a bare `x <command>` means, when it means anything. Declared, never inferred: the parser
   * used to answer `subcommands[0]`, so `x db` ran `gen` — the migration GENERATOR — because it
   * sorted first. A command with no defensible default omits this and the parser refuses instead.
   */
  readonly defaultSubcommand?: string;
  readonly flags?: readonly FlagSpec[];
  /** Command needs an app root (`app.config.ts`) — the dispatcher enforces it. */
  readonly requiresApp?: boolean;
}

export interface ParsedArgs {
  readonly command: string;
  readonly subcommand: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, FlagValue>;
  readonly json: boolean;
  readonly help: boolean;
  /** Everything after a bare `--`, handed to the underlying tool verbatim. */
  readonly passthrough: readonly string[];
}

/** Accepted by every command. `--json` is axiom 4: the feedback loop is machine-readable. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'json', type: 'boolean', summary: 'machine-readable output', short: 'j' },
  { name: 'help', type: 'boolean', summary: 'usage for this command', short: 'h' },
  { name: 'cwd', type: 'string', summary: 'run as if started in this directory' },
  { name: 'verbose', type: 'boolean', summary: 'include step output on success' },
];

/**
 * Whether raw argv asked for JSON, readable BEFORE the parse succeeds. The parse-failure path in
 * `dispatch.ts` has no `ParsedArgs` to read `--json` off — and it used to test `argv.includes`
 * for the long form only, so `x doctor -j --bogusflag` rendered its `X_CLI_BAD_FLAG` as prose to
 * an agent that had asked for JSON and then called `JSON.parse` on it. One detection, two callers.
 */
export const wantsJson = (argv: readonly string[]): boolean =>
  argv.some((token) => token === '--json' || token === '-j');

const HELP_ALIASES = new Set(['--help', '-h', 'help']);
const VERSION_ALIASES = new Set(['--version', '-v', '-V']);

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[] = new Array<number>(rows * cols).fill(0);
  const at = (r: number, c: number): number => grid[r * cols + c] ?? 0;
  for (let r = 0; r < rows; r += 1) grid[r * cols] = r;
  for (let c = 0; c < cols; c += 1) grid[c] = c;
  for (let r = 1; r < rows; r += 1) {
    for (let c = 1; c < cols; c += 1) {
      const cost = a[r - 1] === b[c - 1] ? 0 : 1;
      grid[r * cols + c] = Math.min(at(r - 1, c) + 1, at(r, c - 1) + 1, at(r - 1, c - 1) + cost);
    }
  }
  return at(rows - 1, cols - 1);
}

/** Nearest known name within an edit distance of 3, so the error can suggest a retry. */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 4;
  for (const candidate of candidates) {
    const score = distance(input, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function resolveCommand(token: string, specs: readonly CommandSpec[]): CommandSpec {
  const found = specs.find((spec) => spec.name === token || (spec.aliases ?? []).includes(token));
  if (found !== undefined) return found;
  const names = specs.map((spec) => spec.name);
  const suggestion = nearest(token, names);
  throw new UnknownCommandError(
    suggestion === undefined
      ? { path: token, known: names }
      : { path: token, known: names, suggestion },
  );
}

function findFlag(name: string, spec: CommandSpec): FlagSpec | undefined {
  const all = [...GLOBAL_FLAGS, ...(spec.flags ?? [])];
  return all.find((flag) => flag.name === name || flag.short === name);
}

function defaults(spec: CommandSpec): Map<string, FlagValue> {
  const out = new Map<string, FlagValue>();
  for (const flag of [...GLOBAL_FLAGS, ...(spec.flags ?? [])]) {
    if (flag.default !== undefined) out.set(flag.name, flag.default);
  }
  return out;
}

/**
 * Parse `x` arguments against the command registry. Throws `X_CLI_UNKNOWN_COMMAND` or
 * `X_CLI_BAD_FLAG` — never returns a partially-valid result, because a command that guesses
 * what you meant is a command an agent cannot reason about.
 */
export function parseArgs(argv: readonly string[], specs: readonly CommandSpec[]): ParsedArgs {
  const tokens = [...argv];
  const cut = tokens.indexOf('--');
  const passthrough = cut === -1 ? [] : tokens.splice(cut + 1);
  if (cut !== -1) tokens.pop();

  if (tokens.length === 0) return blank('help', specs, false);
  const first = tokens[0] ?? '';
  // `help` and `version` short-circuit the flag loop below, so `--json` has to be read here or the
  // two commands silently print prose to an agent that asked for JSON — and every `fix:` naming
  // `x help --json` would be a command that does not do what it says.
  const json = wantsJson(tokens);
  if (VERSION_ALIASES.has(first)) return blank('version', specs, json);
  if (HELP_ALIASES.has(first)) {
    const rest = tokens.slice(1).filter((token) => !token.startsWith('-'));
    return { ...blank('help', specs, json), positionals: rest };
  }

  const spec = resolveCommand(first, specs);
  const flags = defaults(spec);
  const positionals: string[] = [];
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    index += 1;
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const negated = token.startsWith('--no-');
    const raw = negated ? token.slice(5) : token.replace(/^--?/, '');
    const [name, inlineValue] = splitInline(raw);
    const flag = findFlag(name, spec);
    if (flag === undefined) {
      const known = [...GLOBAL_FLAGS, ...(spec.flags ?? [])].map((entry) => entry.name);
      const suggestion = nearest(name, known);
      throw new BadFlagError({
        flag: name,
        command: spec.name,
        reason:
          suggestion === undefined
            ? `unknown flag (known: ${known.join(', ')})`
            : `unknown flag — did you mean --${suggestion}?`,
      });
    }
    if (flag.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new BadFlagError({
          flag: flag.name,
          command: spec.name,
          reason: 'boolean flag takes no value',
        });
      }
      flags.set(flag.name, !negated);
      continue;
    }
    const value = inlineValue ?? tokens[index];
    if (value === undefined || value.startsWith('--')) {
      throw new BadFlagError({
        flag: flag.name,
        command: spec.name,
        reason: 'expects a value',
      });
    }
    if (inlineValue === undefined) index += 1;
    flags.set(flag.name, value);
  }

  const subcommand = readSubcommand(spec, positionals);
  return {
    command: spec.name,
    subcommand,
    positionals: subcommand === undefined ? positionals : positionals.slice(1),
    flags,
    json: flags.get('json') === true,
    help: flags.get('help') === true,
    passthrough,
  };
}

function splitInline(raw: string): [string, string | undefined] {
  const eq = raw.indexOf('=');
  if (eq === -1) return [raw, undefined];
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function readSubcommand(spec: CommandSpec, positionals: readonly string[]): string | undefined {
  const allowed = spec.subcommands;
  if (allowed === undefined || allowed.length === 0) return undefined;
  const token = positionals[0];
  if (token === undefined) {
    if (spec.defaultSubcommand !== undefined) return spec.defaultSubcommand;
    throw new MissingSubcommandError({ command: spec.name, known: allowed });
  }
  if (allowed.includes(token)) return token;
  const suggestion = nearest(token, allowed);
  throw new UnknownCommandError(
    suggestion === undefined
      ? { path: `${spec.name} ${token}`, known: allowed }
      : { path: `${spec.name} ${token}`, known: allowed, suggestion: `${spec.name} ${suggestion}` },
  );
}

function blank(command: string, specs: readonly CommandSpec[], json: boolean): ParsedArgs {
  const spec = specs.find((entry) => entry.name === command);
  const flags = spec === undefined ? new Map<string, FlagValue>() : defaults(spec);
  // Set on both, because `flagBool(args, 'json')` and `args.json` are the same fact read two ways.
  flags.set('json', json);
  return {
    command,
    subcommand: undefined,
    positionals: [],
    flags,
    json,
    help: false,
    passthrough: [],
  };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function flagList(args: ParsedArgs, name: string): readonly string[] {
  const value = flagString(args, name);
  if (value === undefined || value.length === 0) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
