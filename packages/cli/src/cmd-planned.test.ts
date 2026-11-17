// The planned table's whole value is that it never lies: every entry is reachable through the
// parser, exits X_NOT_IMPLEMENTED rather than "no such command", and its fix names a command this
// build actually ships. Each of those three is one assertion below.

import { describe, expect, test } from 'bun:test';
import { NotImplementedError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import {
  PLANNED_COMMANDS,
  PLANNED_SUBCOMMANDS,
  plannedCommands,
  plannedSubcommand,
} from './cmd-planned';
import type { CommandContext } from './command';
import { exec } from './exec';
import { citedCommandProblem, loadCommandCatalog } from './fix-command';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: '/tmp',
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
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

describe('unit · the planned subcommand table', () => {
  test('every entry names a subcommand its own command actually declares', () => {
    for (const planned of PLANNED_SUBCOMMANDS) {
      const spec = commandFor(planned.command)?.spec;
      expect(spec?.subcommands ?? []).toContain(planned.subcommand);
    }
  });

  test('every fix names a shipped command, and never the planned subcommand itself', () => {
    const shipped = new Set(
      SPECS.filter((spec) => !spec.summary.endsWith('(planned)')).map((spec) => spec.name),
    );
    for (const planned of PLANNED_SUBCOMMANDS) {
      const words = runnableOf(planned.fix);
      expect(words[0]).toMatch(/^(x|bun)$/);
      if (words[0] === 'x') expect(shipped.has(words[1] ?? '')).toBe(true);
      expect(planned.fix.startsWith(`x ${planned.command} ${planned.subcommand}`)).toBe(false);
    }
  });

  test('an unlisted subcommand still fails as not-implemented, never as a bare throw', () => {
    const error = plannedSubcommand('db', 'nope');
    expect(error).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error.cause).toBe('x db nope is not implemented in this build');
    // `x db --help` is refused by the parser — `db` declares subcommands and no default, so the
    // subcommand is resolved before help is rendered. A fix has to be a command that runs.
    expect(error.fix).toBe('x help db');
  });
});

describe('unit · what a planned command tells the caller', () => {
  // Shipped in 31.x (plan 101-full-stack-efficiency-sweeps U5): each now runs its own body, and a
  // row left here would answer X_NOT_IMPLEMENTED for a command that works.
  test('token, config, logs, cache and status are shipped, never planned', () => {
    for (const name of ['token', 'config', 'logs', 'cache', 'status']) {
      expect([name, PLANNED_COMMANDS.some((entry) => entry.name === name)]).toEqual([name, false]);
      expect([name, commandFor(name)?.spec.summary.endsWith('(planned)')]).toEqual([name, false]);
    }
  });

  // Plan 101b slice 13: finished means this list is empty. Each left with a decision row in
  // wiki/Known-Gaps.md naming its extension point; a row that returns needs a plan that builds it.
  test('branch, ai and money left the registry, each with its Known-Gaps decision', async () => {
    const gaps = await Bun.file(`${import.meta.dir}/../../../wiki/Known-Gaps.md`).text();
    for (const [name, row] of [
      ['branch', '| `x branch`,'],
      ['ai', '| `x ai`:'],
      ['money', '| `x money add-currency`,'],
    ] as const) {
      expect([name, PLANNED_COMMANDS.some((entry) => entry.name === name)]).toEqual([name, false]);
      expect([name, commandFor(name)]).toEqual([name, undefined]);
      expect([name, gaps.includes(row) && gaps.includes('not planned')]).toEqual([name, true]);
    }
  });

  test('every planned fix resolves as an invocation, three words deep', async () => {
    // `runnableOf` above reads the first two words. `x db branch list` passed that check while
    // `x db branch` had no verbs at all, because nothing looked at the third.
    const catalog = await loadCommandCatalog();
    for (const planned of PLANNED_COMMANDS) {
      expect(citedCommandProblem(planned.fix, catalog)).toBeUndefined();
    }
  });
});
