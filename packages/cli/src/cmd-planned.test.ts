// The planned tables stay empty and nothing in the registry claims otherwise; the one builder left
// is a deprecated public export, which still answers the shape its callers were promised.

import { describe, expect, test } from 'bun:test';
import { NotImplementedError } from '@ultimat3/core';
import { PLANNED_COMMANDS, PLANNED_SUBCOMMANDS, plannedSubcommand } from './cmd-planned';
import { commandFor, SPECS } from './registry';

describe('unit · the planned tables', () => {
  // A row here would reach no parser and no `run`: the registry no longer builds commands from it.
  test('both are empty', () => {
    expect(PLANNED_COMMANDS).toEqual([]);
    expect(PLANNED_SUBCOMMANDS).toEqual([]);
  });

  test('no registered command is labelled planned', () => {
    expect(SPECS.filter((spec) => spec.summary.endsWith('(planned)'))).toEqual([]);
  });

  test('names are unique across the whole registry', () => {
    const names = SPECS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Plan 101b slice 13: each left with a decision row in wiki/Known-Gaps.md naming its extension
  // point.
  test('branch, ai and money left the registry, each with its Known-Gaps decision', async () => {
    const gaps = await Bun.file(`${import.meta.dir}/../../../wiki/Known-Gaps.md`).text();
    for (const [name, row] of [
      ['branch', '| `x branch`,'],
      ['ai', '| `x ai`:'],
      ['money', '| `x money add-currency`,'],
    ] as const) {
      expect([name, commandFor(name)]).toEqual([name, undefined]);
      expect([name, gaps.includes(row) && gaps.includes('not planned')]).toEqual([name, true]);
    }
  });
});

describe('unit · plannedSubcommand, deprecated', () => {
  test('still answers X_NOT_IMPLEMENTED with a fix that runs', () => {
    const error = plannedSubcommand('db', 'nope');
    expect(error).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error.cause).toBe('x db nope is not implemented in this build');
    // `x db --help` is refused by the parser: `db` declares subcommands and no default.
    expect(error.fix).toBe('x help db');
  });
});
