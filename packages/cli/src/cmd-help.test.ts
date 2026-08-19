// `x help` is generated from the same specs the parser reads, so it can never describe a flag that
// does not exist. What is asserted here is the half nothing covered: what the human renderer
// actually prints, once each.

import { describe, expect, test } from 'bun:test';
import { createHelpCommand, createVersionCommand, renderHelp } from './cmd-help';
import type { CommandContext } from './command';
import { exec } from './exec';
import { msg } from './messages';
import { renderHuman } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

// Every field `CommandContext` declares, because `packages/cli/tsconfig.json` excludes
// `src/**/*.test.ts` — `tsc -b` never reads this file, so a short context compiles nowhere and
// fails nothing. `x help` reads none of them; they are here because the type says so.
const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs([...argv], SPECS),
  cwd: import.meta.dir,
  runner: exec,
  env: {},
  bunVersion: Bun.version,
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

  // `x help <cmd>` renders `spec.flags` directly, so a flag missing from `usage` is NOT invisible
  // there — but the usage line and `wiki/CLI-Reference.md` still disagreed about `x new --force`
  // and `x dev --once`, and the wiki is the surface an agent reads first. Two commands, named,
  // because five others (`g`, `db`, `deploy`, `manifest`, `jobs`) still omit flags from a usage
  // line this rule would have to be widened across in one commit.
  test('x new and x dev name every flag they declare in their own usage line', () => {
    for (const name of ['new', 'dev']) {
      const spec = SPECS.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      for (const flag of spec?.flags ?? []) {
        // A boolean declared `example` is written `--no-example`: the negation IS the mention.
        const named =
          spec?.usage.includes(`--${flag.name}`) === true ||
          spec?.usage.includes(`--no-${flag.name}`) === true;
        expect([name, flag.name, named]).toEqual([name, flag.name, true]);
      }
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

// `--json` filtered on `spec.name === topic` while the page beside it resolved aliases and fell
// back to the catalogue, so the two renderers answered different questions: `x help generate --json`
// said `[]` — which an agent reads as "no such command" — about the page printed next to it.
describe('unit · x help --json carries what the page renders', () => {
  const jsonNames = async (topic?: string): Promise<readonly string[]> => {
    const argv = topic === undefined ? ['help', '--json'] : ['help', topic, '--json'];
    const result = await helpCommand.run(contextFor(argv));
    const entries = result.data as readonly { readonly name: string }[];
    return entries.map((entry) => entry.name);
  };

  test('an ALIAS resolves to the same one command the page prints', async () => {
    // Not a tautology: `g` declares `aliases: ['generate']`, and the page for either is `g`'s.
    expect(renderHelp(SPECS, 'generate')[0]).toContain('g —');
    expect(await jsonNames('generate')).toEqual(['g']);
    expect(await jsonNames('g')).toEqual(['g']);
  });

  test('an unknown topic answers the whole catalogue, exactly as the page does', async () => {
    expect(renderHelp(SPECS, 'nosuch')).toEqual(renderHelp(SPECS, undefined));
    expect(await jsonNames('nosuch')).toEqual(await jsonNames());
    expect((await jsonNames('nosuch')).length).toBe(SPECS.length);
  });
});

describe('unit · x version', () => {
  // A resolver, not a string: `registry.ts` builds COMMANDS at module scope, and a manifest read
  // there runs in every process that imports `@ultimat3/cli` — a compiled `apps/web/server.ts`
  // included. So the read must happen inside `run()`, and not before.
  test('the version function is not called until the command runs', async () => {
    let reads = 0;
    const command = createVersionCommand(() => {
      reads += 1;
      return '9.9.9';
    });
    expect(reads).toBe(0);
    const result = await command.run(contextFor(['version']));
    expect(reads).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('version');
    expect(result.summary).toBe('9.9.9');
  });

  test('--json carries both versions a bug report needs', async () => {
    const result = await createVersionCommand(() => '3.0.0').run(contextFor(['version', '--json']));
    expect(result.data).toEqual({ version: '3.0.0', bun: Bun.version });
  });

  test('its spec declares the usage line the help table prints', () => {
    const spec = createVersionCommand(() => '3.0.0').spec;
    expect(spec.name).toBe('version');
    expect(spec.usage).toBe('x version [--json]');
  });
});
