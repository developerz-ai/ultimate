// The conditional rule, from both sides. The failure case first: a `fix:` citing a command this
// build does not ship. The second half matters just as much — a fix that cites NO command must
// keep passing, because `set OTEL_EXPORTER_OTLP_ENDPOINT=…` is executable and correctly cites
// nothing, and a universal rule would push an author into naming a command that does not fix it.

import { describe, expect, test } from 'bun:test';
import type { CommandCatalog } from './fix-command';
import { citedCommandProblem, fixCitations, loadCommandCatalog } from './fix-command';

const catalog: CommandCatalog = {
  specs: [
    { name: 'jobs', summary: '', usage: '', subcommands: ['ls', 'show', 'cancel'] },
    { name: 'db', summary: '', usage: '', subcommands: ['gen', 'migrate', 'studio'] },
    { name: 'new', summary: '', usage: '' },
    { name: 'generate', summary: '', usage: '', aliases: ['g'] },
    { name: 'logs', summary: '', usage: '' },
  ],
  planned: new Set(['logs']),
  plannedSubcommands: new Set(['db studio']),
};

describe('a fix that cites a command this build does not ship', () => {
  test('an unknown command is the finding', () => {
    expect(citedCommandProblem('x trace --json', catalog)).toContain('not a command');
  });

  test('a PLANNED command is the finding — it parses, and then refuses', () => {
    // The reason resolving against the registry alone is not enough: `x logs tail` is in `SPECS`,
    // `x help` lists it, and running it hands the reader X_NOT_IMPLEMENTED instead of the fix.
    expect(citedCommandProblem('x logs --json | tail -50', catalog)).toContain('X_NOT_IMPLEMENTED');
  });

  test('an unknown subcommand is the finding, and it lists the real ones', () => {
    const problem = citedCommandProblem('x jobs list --state dead --json', catalog);
    expect(problem).toContain('no such subcommand');
    expect(problem).toContain('ls, show, cancel');
  });

  test('a planned subcommand is the finding too', () => {
    expect(citedCommandProblem('x db studio', catalog)).toContain('X_NOT_IMPLEMENTED');
  });
});

describe('the rule is conditional, not universal', () => {
  test('a fix that cites no command at all holds', () => {
    // Both of these are executable and neither names a CLI command. A rule that demanded one
    // would fail the two clearest fix lines the framework ships.
    expect(
      citedCommandProblem('set OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318', catalog),
    ).toBeUndefined();
    expect(
      citedCommandProblem("counter('orders_total', { maxSeries: 4000 })", catalog),
    ).toBeUndefined();
  });

  test('a real command, with and without a real subcommand, holds', () => {
    expect(citedCommandProblem('x jobs cancel <id> --json', catalog)).toBeUndefined();
    expect(citedCommandProblem('x db migrate', catalog)).toBeUndefined();
    expect(citedCommandProblem('x new my-app', catalog)).toBeUndefined();
  });

  test('a second word is judged only when the spec declares subcommands', () => {
    // `x new my-app` and `x g route posts` take positionals. Reporting `my-app` as an unknown
    // subcommand would be a finding about a working example.
    expect(citedCommandProblem('x new my-app --json', catalog)).toBeUndefined();
  });

  test('an alias resolves — `x g` is `x generate`', () => {
    expect(citedCommandProblem('x g route posts', catalog)).toBeUndefined();
  });

  test('a digit is part of a name, not a boundary', () => {
    // `x i18n check` read through `[a-z-]*` cites `x i`, which is not a command — three of the
    // framework's own fix lines were false findings until the character class allowed digits.
    expect(fixCitations('x i18n check --json')).toEqual([{ command: 'i18n', sub: 'check' }]);
  });

  test('`x` with nothing after it cites nothing', () => {
    expect(fixCitations('run x')).toEqual([]);
    expect(fixCitations('x --json')).toEqual([]);
  });

  test('an interpolated command name is out of reach and is not guessed at', () => {
    // The caller blanks `${…}` to `<value>` before this runs, so there is no name to resolve and
    // no finding to report — the same limit `ts-scan.ts` states about a fix with no literal.
    expect(citedCommandProblem('x <value> --json', catalog)).toBeUndefined();
  });
});

describe('the catalog is the registry, never a copy of it', () => {
  test('it loads, and it knows the shipped commands from the planned ones', async () => {
    const real = await loadCommandCatalog();
    expect(real.specs.some((spec) => spec.name === 'jobs')).toBe(true);
    // If this ever goes false the command shipped, and the check stops reporting it — which is
    // exactly what should happen.
    expect(real.planned.size).toBeGreaterThan(0);
    expect(real.plannedSubcommands.has('db studio')).toBe(true);
  });

  test('`x jobs cancel` resolves against the real registry, because it now exists', async () => {
    expect(citedCommandProblem('x jobs cancel <id>', await loadCommandCatalog())).toBeUndefined();
  });
});
