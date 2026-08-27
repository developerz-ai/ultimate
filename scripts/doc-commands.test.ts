// The failure case first: a page that hands its reader a command this build refuses. Then the two
// ways this rule could stop being one — an allowance nothing uses, and a glob that reads no file at
// all, which is how a check written to close a false green ships with one.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { CommandCatalog } from '@ultimat3/cli';
import {
  checkDocCommands,
  docCommandFindingFor,
  docCommandGaps,
  PINS_FILE,
  skipDocPath,
} from './doc-commands';
import type { DocCommandAllowance } from './doc-commands-allow';
import { DOC_COMMAND_ALLOWANCES } from './doc-commands-allow';
import type { MarkdownFile } from './lib/doc-citations';
import { scanDocCitations } from './lib/doc-citations';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const catalog: CommandCatalog = {
  specs: [
    { name: 'db', summary: '', usage: '', subcommands: ['gen', 'migrate', 'studio'] },
    {
      name: 'env',
      summary: '',
      usage: '',
      subcommands: ['check'],
      flags: [{ name: 'write', type: 'boolean', summary: '' }],
    },
    { name: 'logs', summary: '', usage: '' },
  ],
  planned: new Set(['logs']),
  plannedSubcommands: new Set(['db studio']),
};

const page = (text: string, path = 'wiki/Page.md') => ({ path, text });
/** No pin by default: an unpinned page is the shape every case below the ratchet block asserts. */
const gaps = (text: string, allow: readonly DocCommandAllowance[] = []) =>
  checkDocCommands({ files: [page(text)], catalog, allow, pins: {} });

describe('a page that names a command this build cannot run', () => {
  test('an unreal subcommand inside a code span is the finding', () => {
    const found = gaps('confirm with `x db query "select 1" --json` first');
    expect(found).toHaveLength(1);
    expect(found[0]?.subject).toBe('x db query');
    expect(found[0]?.at).toBe('wiki/Page.md:1');
  });

  test('an unreal FLAG is the finding — it dies at the parser, not at the command', () => {
    // `x env check --fix` was on three pages. The command and the subcommand both resolve.
    const found = gaps('| Repair | `x env check --fix` writes the missing keys |');
    expect(found[0]?.subject).toBe('x env --fix');
    expect(docCommandFindingFor(found[0] as never).cause).toContain('X_CLI_BAD_FLAG');
  });

  test('a shell fence is read — that is where a reader copies from', () => {
    expect(gaps('```\n  fix:   x db query "select 1"\n```')).toHaveLength(1);
  });

  test('the finding names the file and the line, so it opens in an editor', () => {
    const finding = docCommandFindingFor(gaps('a\nb\n`x db query`')[0] as never);
    expect(finding.at).toBe('wiki/Page.md:3');
    expect(finding.code).toBe('X_DOC_COMMAND_UNKNOWN');
  });
});

describe('planned stays sayable', () => {
  test('a planned command is not a finding — the wiki has a table whose job is to name them', () => {
    expect(gaps('`x logs tail --json` (planned)')).toEqual([]);
  });

  test('a planned SUBCOMMAND is not either — `x db studio` is the only one', () => {
    expect(gaps('`x db studio` opens the schema browser (planned)')).toEqual([]);
  });

  test('and neither widens anything else on the same page', () => {
    expect(gaps('`x logs tail` and `x db query`')).toHaveLength(1);
  });
});

describe('what is not read, and why', () => {
  test('a `ts` fence is not shell — its `x` is a variable', () => {
    expect(gaps('```ts\nconst x = db.query(sql);\n```')).toEqual([]);
  });

  test('prose outside a code span is not a citation', () => {
    // "the x axis" is not an invocation, and a rule reading bare prose reports on sentences.
    expect(gaps('plot the x db values against time')).toEqual([]);
  });

  test('docs/plans is a dated record of work, and quotes broken commands as evidence', () => {
    expect(skipDocPath('docs/plans/2026/08/16/101-deep-dive-bug-audit/13-docs-drift.md')).toBe(
      true,
    );
    expect(skipDocPath('docs/architecture/04-error-contract.md')).toBe(false);
  });

  test('the error reference has one owner, and it is scripts/doc-fixes.ts', () => {
    // Its Fix column is held to a STRICTER rule there — a fix may not cite a planned command.
    expect(skipDocPath('wiki/Error-Codes.md')).toBe(true);
  });

  test('one line naming one invocation twice is one finding', () => {
    expect(gaps('| Repair | `x db query` | see `x db query` |')).toHaveLength(1);
  });
});

describe('the rule cannot quietly stop being one', () => {
  test('an allowance that matches nothing is a finding', () => {
    const stale: DocCommandAllowance = {
      path: 'wiki/Gone.md',
      cites: 'x serve',
      kind: 'absent',
      why: 'the page said there is no such command',
    };
    const found = gaps('nothing here', [stale]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('allowance');
    expect(docCommandFindingFor(found[0] as never).code).toBe('X_DOC_COMMAND_ALLOWANCE_STALE');
  });

  test('an allowance that matches suppresses exactly its own page and citation', () => {
    const allow: DocCommandAllowance = {
      path: 'wiki/Page.md',
      cites: 'x db query',
      kind: 'absent',
      why: 'the sentence is that it never existed',
    };
    expect(gaps('`x db query` never existed', [allow])).toEqual([]);
    // ...and not the same citation on another page
    const other = checkDocCommands({
      files: [page('`x db query`', 'wiki/Other.md')],
      catalog,
      allow: [allow],
      pins: {},
    });
    expect(other.map((one) => one.kind)).toEqual(['unresolved', 'allowance']);
  });

  test('NO FILE READ is a failure, never a pass', () => {
    // The defect a reviewer caught in three of the four gate checks written this month: a check
    // that answers "everything resolved" over a file set it never opened.
    const found = checkDocCommands({ files: [], catalog, allow: [], pins: {} });
    expect(found[0]?.kind).toBe('vacuous');
    expect(docCommandFindingFor(found[0] as never).code).toBe('X_DOC_COMMAND_UNSCANNED');
  });
});

describe('the pin is a ratchet, so it may only shrink', () => {
  const pinned = (pins: Readonly<Record<string, number>>, ...files: readonly MarkdownFile[]) =>
    checkDocCommands({ files, catalog, allow: [], pins });
  const two = page('`x db query`\n`x db drift`', 'wiki/Pinned.md');

  test('a page holding exactly its pin reports nothing — that is what a pin buys', () => {
    expect(pinned({ 'wiki/Pinned.md': 2 }, two)).toEqual([]);
  });

  test('one more than the pin never offers to raise it', () => {
    // This test asserted the defect until 2026-08-22: it expected the SAME code and the same fix
    // the improved direction gets, which is `set DOC_COMMAND_PINS[…] to the first number in the
    // detail` — the bigger number. A ratchet printing the instruction for raising itself.
    const found = pinned({ 'wiki/Pinned.md': 1 }, two);
    expect(found.map((one) => one.kind)).toEqual(['pin-exceeded']);
    expect(found[0]?.subject).toBe('wiki/Pinned.md');
    expect(found[0]?.detail).toBe('2 now, pinned at 1');
    const finding = docCommandFindingFor(found[0] as never);
    expect(finding.code).toBe('X_DOC_COMMAND_PIN_EXCEEDED');
    expect(finding.fix).not.toContain('DOC_COMMAND_PINS');
    expect(finding.cause).toContain('may only come down');
  });

  test('a pin ABOVE what the page holds is a finding too — slack is a waiver nobody reads', () => {
    const found = pinned({ 'wiki/Pinned.md': 2 }, page('`x db query`', 'wiki/Pinned.md'));
    expect(found.map((one) => one.kind)).toEqual(['pin']);
    expect(found[0]?.detail).toBe('1 now, pinned at 2');
    // The direction that DOES ask for the number, so the two fixes are provably not one string.
    const finding = docCommandFindingFor(found[0] as never);
    expect(finding.fix).toContain(
      "set DOC_COMMAND_PINS['wiki/Pinned.md'] in scripts/doc-commands.ts",
    );
    // `at` is the file the fix EDITS, and the two directions edit different files: this one lowers
    // a number in the pin table, `pin-exceeded` above corrects citations in the page itself.
    expect(finding.at).toBe(PINS_FILE);
    expect(docCommandFindingFor(pinned({ 'wiki/Pinned.md': 1 }, two)[0] as never).at).toBe(
      'wiki/Pinned.md',
    );
  });

  test('a pin that no page contradicts is still checked against zero', () => {
    // The stale-allowance rule, one file set on: a pinned page whose last bad citation was fixed
    // must lose its entry, or the number outlives the debt it recorded.
    const found = pinned({ 'wiki/Gone.md': 1 }, page('nothing here'));
    expect(found.map((one) => one.kind)).toEqual(['pin']);
    expect(found[0]?.detail).toBe('0 now, pinned at 1');
    expect(docCommandFindingFor(found[0] as never).fix).toContain(
      "DOC_COMMAND_PINS['wiki/Gone.md']",
    );
  });

  test('a pin suppresses its own page and no other', () => {
    const found = pinned(
      { 'wiki/Pinned.md': 1 },
      page('`x db query`', 'wiki/Pinned.md'),
      page('`x db query`', 'wiki/Other.md'),
    );
    expect(found.map((one) => one.kind)).toEqual(['unresolved']);
    expect(found[0]?.at).toBe('wiki/Other.md:1');
  });
});

describe('against this repo', () => {
  test('the glob reads the real wiki, so the rule is not vacuous here', async () => {
    const found = await docCommandGaps(repoRoot());
    expect(found.some((one) => one.kind === 'vacuous')).toBe(false);
  }, 20_000);

  test('every allowance names a path that exists and a citation that page still writes', async () => {
    // The allowance list's own hygiene, proved against the tree rather than against a fixture.
    const found = await docCommandGaps(repoRoot());
    expect(found.filter((one) => one.kind === 'allowance')).toEqual([]);
    expect(DOC_COMMAND_ALLOWANCES.length).toBeGreaterThan(0);
  }, 20_000);

  test('the scanner reads the pages it is pointed at', () => {
    expect(scanDocCitations(page('`x db migrate`')).length).toBe(1);
  });
});
