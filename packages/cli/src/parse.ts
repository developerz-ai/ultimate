// Argument parsing for the whole `x` binary — one parser, so every command accepts flags the
// same way and `--json` / `--help` behave identically everywhere. Pure: no I/O, no process
// access, so the parser is unit-testable and the dispatcher owns all side effects.

import { nearestName } from '@ultimat3/core';
import { BadFlagError, MissingSubcommandError, UnknownCommandError } from './errors';

/**
 * The historical name for `@ultimat3/core`'s `nearestName`, kept because it shipped on this
 * package's exported surface and removing it would be a major for a rename. One implementation
 * behind both — this is a delegation, not the second copy of the algorithm that `@ultimat3/policy`
 * used to carry. New callers import `nearestName` from core.
 */
export const nearest = nearestName;

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
  /**
   * A closed set the FIRST positional must come from, where the command has one. Declarative only:
   * the parser leaves positionals to the command, because `x test`'s own `readOnlyType` already
   * refuses an unknown type with the list. What this adds is a set `fix-command.ts` can resolve a
   * citation against. `packages/ai/src/eval-errors.ts` avoids `x test <eval-name>` by hand, with a
   * three-line comment explaining that it is `X_CLI_BAD_FLAG` — a convention held by memory,
   * because nothing outside `cmd-test.ts` knew what `x test` accepts. Declare it from the SAME
   * constant the command validates against, never a second literal.
   */
  readonly positionalChoices?: readonly string[];
  /**
   * The same closed set, one level down: the set a named SUBCOMMAND's first positional must come
   * from. `positionalChoices` cannot express it, because `fix-command.ts` only consults that field
   * where a command declares NO subcommands — so `x db branch ls` resolved as command +
   * subcommand and nothing ever looked at `ls`. That is how a shipped `fix:` told an agent to run
   * a listing while `x db branch` read `ls` as a branch name and created a database from it.
   * Declarative only, exactly like `positionalChoices`: the command still refuses an unknown word
   * itself, and this is declared from the SAME constant it validates against.
   */
  readonly subcommandPositionals?: Readonly<Record<string, readonly string[]>>;
  readonly flags?: readonly FlagSpec[];
  /**
   * Command needs an app root (`app.config.ts`). The dispatcher enforces it — `dispatch.ts`, before
   * `target.run` — and until 2026-08 nothing read this field at all: the guarantee was kept only by
   * each of the 17 declaring commands remembering to call `requireAppRoot` itself, so a new command
   * that declared it and forgot the call ran outside an app with no refusal.
   */
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

function resolveCommand(token: string, specs: readonly CommandSpec[]): CommandSpec {
  const found = specs.find((spec) => spec.name === token || (spec.aliases ?? []).includes(token));
  if (found !== undefined) return found;
  const names = specs.map((spec) => spec.name);
  const suggestion = nearestName(token, names);
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
      const suggestion = nearestName(name, known);
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
  const suggestion = nearestName(token, allowed);
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
