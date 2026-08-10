import { describe, expect, test } from 'bun:test';
import { UnknownCommandError } from './errors';
import type { CommandSpec } from './parse';
import { flagBool, flagString, parseArgs } from './parse';
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

  test('defaults a subcommand to the first declared one', () => {
    expect(parseArgs(['db'], SPECS).subcommand).toBe('gen');
  });

  test('accepts --json on every command and exposes it as a boolean', () => {
    for (const command of ['verify', 'db', 'g']) {
      expect(parseArgs([command, '--json'], SPECS).json).toBe(true);
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
    expect(() => parseArgs(['db', 'branch', '--name'], SPECS)).toThrow();
  });

  test('bare argv and --help both route to the help command', () => {
    expect(parseArgs([], SPECS).command).toBe('help');
    expect(parseArgs(['--help'], SPECS).command).toBe('help');
    expect(parseArgs(['help', 'db'], SPECS).positionals).toEqual(['db']);
    expect(parseArgs(['--version'], SPECS).command).toBe('version');
  });
});
