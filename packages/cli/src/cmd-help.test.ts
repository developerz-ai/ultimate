// `x help` is generated from the same specs the parser reads, so it can never describe a flag that
// does not exist. What is asserted here is the half nothing covered: what the human renderer
// actually prints, once each.

import { describe, expect, test } from 'bun:test';
import { createHelpCommand, renderHelp } from './cmd-help';
import type { CommandContext } from './command';
import { exec } from './exec';
import { msg } from './messages';
import { renderHuman } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs([...argv], SPECS),
  cwd: process.cwd(),
  runner: exec,
});

const helpCommand = createHelpCommand(() => SPECS);

describe('unit · x help', () => {
  // The hint is the command's `summary`, and `renderHuman` prints every line and THEN the summary.
  // Listing it among the lines as well printed one sentence twice — once bare, once marked `✓` —
  // which reads as two instructions to whoever is being told how to ask for more.
  test('the closing hint is printed exactly once', async () => {
    const result = await helpCommand.run(contextFor([]));
    const hint = msg('cli.hint.help');
    expect(
      renderHuman(result)
        .split('\n')
        .filter((line) => line.includes(hint)),
    ).toHaveLength(1);
    expect(result.summary).toBe(hint);
  });

  test('the catalogue names every command the registry ships', () => {
    const lines = renderHelp(SPECS, undefined);
    for (const spec of SPECS) {
      expect(lines.some((line) => line.trim().startsWith(spec.name))).toBe(true);
    }
  });

  // One command's page is a different shape: the hint is the summary there too, but it is not in
  // the body at all, so nothing about this change may add it back.
  test('one command page carries its usage and no catalogue hint', () => {
    const lines = renderHelp(SPECS, 'verify');
    expect(lines[0]).toContain('verify —');
    expect(lines.some((line) => line.includes(msg('cli.hint.help')))).toBe(false);
  });
});
