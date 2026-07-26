import { describe, expect, test } from 'bun:test';
import { UnknownCommandError } from './errors';
import type { CommandSpec } from './parse';
import { flagBool, flagString, parseArgs } from './parse';

const SPECS: readonly CommandSpec[] = [
  {
    name: 'verify',
    summary: 'the gate',
    usage: 'x verify',
    flags: [{ name: 'only', type: 'string', summary: 'steps' }],
  },
  {
    name: 'db',
    summary: 'database',
    usage: 'x db <sub>',
    subcommands: ['gen', 'migrate', 'branch'],
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
    expect(flagString(parseArgs(['verify', '--only', 'lint'], SPECS), 'only')).toBe('lint');
    expect(flagString(parseArgs(['verify', '--only=lint,drift'], SPECS), 'only')).toBe(
      'lint,drift',
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
    const args = parseArgs(['verify', '--', '--only', 'nonsense'], SPECS);
    expect(args.passthrough).toEqual(['--only', 'nonsense']);
    expect(flagString(args, 'only')).toBeUndefined();
  });

  test('an unknown command throws X_CLI_UNKNOWN_COMMAND with a suggestion', () => {
    expect(() => parseArgs(['verfy'], SPECS)).toThrow(UnknownCommandError);
    try {
      parseArgs(['verfy'], SPECS);
    } catch (error) {
      const failure = error as UnknownCommandError & { fix: string; code: string };
      expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
      expect(failure.fix).toBe('x verify');
    }
  });

  test('an unknown subcommand names the command path, not just the token', () => {
    try {
      parseArgs(['db', 'frobnicate'], SPECS);
      throw new Error('expected a throw');
    } catch (error) {
      const failure = error as { code?: string; cause?: string };
      expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
      expect(String(failure.cause)).toContain('db frobnicate');
    }
  });

  test('an unknown flag throws X_CLI_BAD_FLAG pointing at the command help', () => {
    try {
      parseArgs(['verify', '--onl', 'lint'], SPECS);
      throw new Error('expected a throw');
    } catch (error) {
      const failure = error as { code?: string; fix?: string };
      expect(failure.code).toBe('X_CLI_BAD_FLAG');
      expect(failure.fix).toBe('x verify --help');
    }
  });

  test('a string flag with no value is an error, not a silent empty string', () => {
    expect(() => parseArgs(['verify', '--only'], SPECS)).toThrow();
  });

  test('bare argv and --help both route to the help command', () => {
    expect(parseArgs([], SPECS).command).toBe('help');
    expect(parseArgs(['--help'], SPECS).command).toBe('help');
    expect(parseArgs(['help', 'db'], SPECS).positionals).toEqual(['db']);
    expect(parseArgs(['--version'], SPECS).command).toBe('version');
  });
});
