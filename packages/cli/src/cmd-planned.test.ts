// The planned table's whole value is that it never lies: every entry is reachable through the
// parser, exits X_NOT_IMPLEMENTED rather than "no such command", and its fix names a command this
// build actually ships. Each of those three is one assertion below.

import { describe, expect, test } from 'bun:test';
import { PLANNED_COMMANDS, plannedCommands } from './cmd-planned';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: '/tmp',
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

/** The first word of a fix line, which is the binary the caller is being told to run. */
const runnableOf = (fix: string): readonly string[] => fix.split('#')[0]?.trim().split(/\s+/) ?? [];

describe('unit · the planned table', () => {
  test('every entry is in the command registry — the parser must reach it', () => {
    for (const planned of PLANNED_COMMANDS) {
      expect(commandFor(planned.name)?.spec.name).toBe(planned.name);
    }
  });

  test('every entry exits X_NOT_IMPLEMENTED, never X_CLI_UNKNOWN_COMMAND', async () => {
    for (const command of plannedCommands()) {
      await expect(command.run(ctxFor([command.spec.name]))).rejects.toBeUltimateError(
        'X_NOT_IMPLEMENTED',
      );
    }
  });

  test('every fix names a shipped command, so it is runnable today', () => {
    const shipped = new Set(
      SPECS.filter((spec) => !spec.summary.endsWith('(planned)')).map((spec) => spec.name),
    );
    for (const planned of PLANNED_COMMANDS) {
      const words = runnableOf(planned.fix);
      expect(words[0]).toMatch(/^(x|bun)$/);
      if (words[0] === 'x') expect(shipped.has(words[1] ?? '')).toBe(true);
    }
  });

  test('a fix never points at another planned command — that is the failure mode', () => {
    const plannedNames = new Set(PLANNED_COMMANDS.map((entry) => entry.name));
    for (const planned of PLANNED_COMMANDS) {
      const words = runnableOf(planned.fix);
      expect(plannedNames.has(words[1] ?? '')).toBe(false);
    }
  });

  test('every summary is labelled (planned) in help, so the catalogue is honest', () => {
    for (const command of plannedCommands()) {
      expect(command.spec.summary.endsWith('(planned)')).toBe(true);
    }
  });

  test('names are unique across the whole registry', () => {
    const names = SPECS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('unit · what a planned command tells the caller', () => {
  test('x cache points at the /_x panel that already answers the question', async () => {
    const cache = commandFor('cache');
    expect(cache).toBeDefined();
    const failure: unknown = await Promise.resolve()
      .then(() => cache?.run(ctxFor(['cache', 'graph'])))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect((failure as { fix: string }).fix).toContain('x dev');
  });

  test('x branch points at the database half that is shipped', () => {
    const planned = PLANNED_COMMANDS.find((entry) => entry.name === 'branch');
    expect(planned?.fix).toBe('x db branch <name>   # the database half, shipped today');
  });
});
