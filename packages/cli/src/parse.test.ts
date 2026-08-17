import { describe, expect, test } from 'bun:test';
import { UnknownCommandError } from './errors';
import type { CommandSpec } from './parse';
import { flagBool, flagString, parseArgs } from './parse';
import { SPECS as SPECS_SHIPPED } from './registry';
import { thrownBy } from './thrown-by';

const SPECS: readonly CommandSpec[] = [
  // `verify` really does declare no flags — narrowing the gate would make "green" mean whatever
  // the caller chose (axiom 5), so the fixture carries no `--only`/`--skip` either.
  { name: 'verify', summary: 'the gate', usage: 'x verify', flags: [] },
  {
    name: 'db',
    summary: 'database',
    usage: 'x db <sub>',
    subcommands: ['gen', 'migrate', 'branch'],
    flags: [{ name: 'name', type: 'string', summary: 'migration or branch name' }],
  },
  { name: 'g', aliases: ['generate'], summary: 'scaffold', usage: 'x g <kind> <name>' },
  { name: 'help', summary: 'help', usage: 'x help' },
  { name: 'version', summary: 'version', usage: 'x version' },
];

describe('unit · parseArgs', () => {
  test('reads a command, its subcommand and its positionals', () => {
    const args = parseArgs(['db', 'branch', 'feat-billing'], SPECS);
    expect(args.command).toBe('db');
    expect(args.subcommand).toBe('branch');
    expect(args.positionals).toEqual(['feat-billing']);
  });

  // Array order is not a declaration. `x db` ran `gen` — a code GENERATOR that writes migration
  // files — because it sorted first in `DB_SUBCOMMANDS`, and no caller ever asked for it.
  test('a command that declares no default subcommand refuses a bare invocation', () => {
    const error = thrownBy(() => parseArgs(['db'], SPECS));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.cause).toContain('gen, migrate, branch');
    // `x help db`, not `x db --help`: the subcommand is resolved AFTER the flag loop, so the
    // latter throws this same error again — a fix line that reproduces its own failure.
    expect(error.fix).toBe('x help db');
    expect(thrownBy(() => parseArgs(['db', '--help'], SPECS)).code).toBe('X_CLI_BAD_FLAG');
  });

  test('a declared default subcommand is the one that answers a bare invocation', () => {
    const specs: readonly CommandSpec[] = [
      { ...(SPECS[1] as CommandSpec), defaultSubcommand: 'migrate' },
    ];
    expect(parseArgs(['db'], specs).subcommand).toBe('migrate');
  });

  // Against the REAL registry, because the rule is about what ships: a default nobody can reach
  // is the same class of dead declaration as `x db`'s `?? 'migrate'` was.
  test('every shipped default subcommand is one the command actually declares', () => {
    for (const spec of SPECS_SHIPPED) {
      if (spec.defaultSubcommand === undefined) continue;
      expect(spec.subcommands ?? []).toContain(spec.defaultSubcommand);
    }
  });

  // The exact set, so adding or removing one is a deliberate edit and not a side effect of an
  // array's order. `x db gen` writes a migration file and `x db reset` drops the database; a bare
  // `x mcp` used to START A SERVER, which is the one thing a word typed by mistake must not do.
  test('exactly the commands whose bare form is dangerous refuse it', () => {
    const refusing = SPECS_SHIPPED.filter(
      (spec) => (spec.subcommands ?? []).length > 0 && spec.defaultSubcommand === undefined,
    ).map((spec) => spec.name);
    expect(refusing.sort()).toEqual(['db', 'mcp']);
  });

  test('accepts --json on every command and exposes it as a boolean', () => {
    // `db` carries its subcommand: it declares no default, so the bare form is refused — and that
    // refusal is still rendered as JSON, by `wantsJson` on raw argv in `dispatch`.
    for (const argv of [['verify'], ['db', 'migrate'], ['g']]) {
      expect(parseArgs([...argv, '--json'], SPECS).json).toBe(true);
    }
    expect(parseArgs(['verify'], SPECS).json).toBe(false);
    expect(parseArgs(['verify', '-j'], SPECS).json).toBe(true);
  });

  test('reads string flags in both --flag value and --flag=value form', () => {
    expect(flagString(parseArgs(['db', 'branch', '--name', 'feat-billing'], SPECS), 'name')).toBe(
      'feat-billing',
    );
    expect(flagString(parseArgs(['db', 'branch', '--name=feat-billing'], SPECS), 'name')).toBe(
      'feat-billing',
    );
  });

  test('--no-<flag> turns a boolean off', () => {
    expect(flagBool(parseArgs(['verify', '--no-verbose'], SPECS), 'verbose')).toBe(false);
    expect(flagBool(parseArgs(['verify', '--verbose'], SPECS), 'verbose')).toBe(true);
  });

  test('resolves aliases to the canonical command name', () => {
    expect(parseArgs(['generate', 'action', 'publishPost'], SPECS).command).toBe('g');
  });

  test('everything after -- is passthrough, not a flag', () => {
    const args = parseArgs(['db', 'branch', '--', '--name', 'nonsense'], SPECS);
    expect(args.passthrough).toEqual(['--name', 'nonsense']);
    expect(flagString(args, 'name')).toBeUndefined();
  });

  test('an unknown command throws X_CLI_UNKNOWN_COMMAND with a suggestion', () => {
    expect(() => parseArgs(['verfy'], SPECS)).toThrow(UnknownCommandError);
    const failure = thrownBy(() => parseArgs(['verfy'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(failure.fix).toBe('x verify');
  });

  test('an unknown subcommand names the command path, not just the token', () => {
    const failure = thrownBy(() => parseArgs(['db', 'frobnicate'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(String(failure.cause)).toContain('db frobnicate');
  });

  test('an unknown flag throws X_CLI_BAD_FLAG pointing at the command help', () => {
    const failure = thrownBy(() => parseArgs(['verify', '--onl', 'lint'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x verify --help');
  });

  test('a string flag with no value is an error, not a silent empty string', () => {
    const failure = thrownBy(() => parseArgs(['db', 'branch', '--name'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(String(failure.cause)).toContain('expects a value');
  });

  test('bare argv and --help both route to the help command', () => {
    expect(parseArgs([], SPECS).command).toBe('help');
    expect(parseArgs(['--help'], SPECS).command).toBe('help');
    expect(parseArgs(['help', 'db'], SPECS).positionals).toEqual(['db']);
    expect(parseArgs(['--version'], SPECS).command).toBe('version');
  });
});
