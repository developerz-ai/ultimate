// The failure case first: a reference row whose Fix cell names a command this build refuses. Then
// the two ways this rule stops being one — a page that is gone, and a page whose tables no longer
// declare a Fix column at all, either of which would otherwise read as "every fix is runnable".

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { CommandCatalog } from '@ultimat3/cli';
import { checkDocFixes, docFixFindingFor, docFixGaps, readFixCells } from './doc-fixes';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const catalog: CommandCatalog = {
  specs: [
    { name: 'db', summary: '', usage: '', subcommands: ['gen', 'migrate', 'studio'] },
    { name: 'cache', summary: '', usage: '', subcommands: ['bust'] },
  ],
  planned: new Set(['cache']),
  plannedSubcommands: new Set(['db studio']),
};

const table = (fix: string) =>
  ['| Code | Means | Fix |', '|---|---|---|', `| \`X_A\` | a thing broke | ${fix} |`].join('\n');

const gaps = (fix: string) => checkDocFixes({ markdown: table(fix), catalog });

describe('a Fix cell that cannot be run as written', () => {
  test('an unreal subcommand is the finding, and it names the code and the line', () => {
    const found = gaps('confirm with `x db query "select 1" --json`');
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_A');
    expect(found[0]?.line).toBe(3);
    expect(docFixFindingFor(found[0] as never).at).toBe('wiki/Error-Codes.md:3');
  });

  test('a PLANNED command in a Fix cell is the finding — a fix may not hand over a second error', () => {
    // This is the whole difference from the prose rule: a page may SAY `x cache bust` is planned,
    // and a Fix column may not tell a reader to run it.
    expect(gaps('`x cache bust <tag>`')[0]?.problem).toContain('X_NOT_IMPLEMENTED');
    expect(gaps('`x db studio`')[0]?.problem).toContain('X_NOT_IMPLEMENTED');
  });

  test('advice with no command is the other half of the same contract', () => {
    const found = gaps('check the outbox worker is draining');
    expect(found[0]?.kind).toBe('advice');
    expect(docFixFindingFor(found[0] as never).code).toBe('X_DOC_FIX_UNRUNNABLE');
  });

  test('a runnable fix holds, whether or not it cites a command', () => {
    expect(gaps('`x db migrate`, then `x db gen "add index"`')).toEqual([]);
    expect(gaps('set `DATABASE_POOL_MAX` below `max_connections / replicas`')).toEqual([]);
  });
});

describe('a Fix cell passing a positional its command does not take', () => {
  const routes: CommandCatalog = {
    ...catalog,
    specs: [
      ...catalog.specs,
      { name: 'routes', summary: '', usage: 'x routes [--surface site|app] [--json]' },
    ],
  };
  const arity = (fix: string) => checkDocFixes({ markdown: table(fix), catalog: routes });

  test('`x routes list --json` is the finding — the retired spelling the 404 fix lines shipped', () => {
    const [gap] = arity('`x routes list --json`');
    expect(gap?.kind).toBe('unrunnable');
    expect(gap?.problem).toContain('cites "x routes list"');
    expect(gap?.problem).toContain('takes no positional word');
    expect(arity('`x routes --json`')).toEqual([]);
  });
});

describe('a cause cell that repeats its title', () => {
  const page = (means: string, cause: string) =>
    [
      '| Code | Means | Typical cause | Fix |',
      '|---|---|---|---|',
      `| \`X_A\` | ${means} | ${cause} | \`x db migrate\` |`,
    ].join('\n');

  test('is the finding, naming the code and the line — the row says what failed twice', () => {
    const found = checkDocFixes({ markdown: page('a thing broke', ' A thing broke '), catalog });
    expect(found.map((gap) => [gap.kind, gap.code, gap.line])).toEqual([['echoed', 'X_A', 3]]);
    const finding = docFixFindingFor(found[0] as never);
    expect(finding.code).toBe('X_DOC_CAUSE_ECHOES_TITLE');
    expect(finding.at).toBe('wiki/Error-Codes.md:3');
  });

  test('a cause of its own holds, and a table with no cause column is not read for one', () => {
    expect(checkDocFixes({ markdown: page('a thing broke', 'the disk filled'), catalog })).toEqual(
      [],
    );
    expect(gaps('`x db migrate`')).toEqual([]);
  });
});

describe('the column is found by its header, never by position', () => {
  test('a table with the Fix column somewhere else is still read', () => {
    const markdown = ['| Fix | Code |', '|---|---|', '| `x db query` | `X_B` |'].join('\n');
    expect(checkDocFixes({ markdown, catalog })[0]?.problem).toContain('x db query');
  });

  test('a fenced block that looks like a table is not one', () => {
    const markdown = ['```', '| Code | Fix |', '|---|---|', '| `X_C` | `x db query` |', '```'].join(
      '\n',
    );
    // No Fix column outside the fence — which this rule reports as vacuous, not as green.
    expect(checkDocFixes({ markdown, catalog })[0]?.kind).toBe('vacuous');
  });

  test('the code is read off the row, so the finding names what an agent hit', () => {
    expect(readFixCells(table('`x db migrate`'))[0]?.code).toBe('X_A');
  });
});

describe('the rule cannot quietly stop being one', () => {
  test('a MISSING page is a failure, never a pass', () => {
    const found = checkDocFixes({ markdown: undefined, catalog });
    expect(found[0]?.kind).toBe('vacuous');
    expect(docFixFindingFor(found[0] as never).code).toBe('X_DOC_FIX_UNSCANNED');
  });

  test('a page with no Fix column anywhere is a failure too', () => {
    const markdown = ['| Code | Means |', '|---|---|', '| `X_A` | a thing broke |'].join('\n');
    expect(checkDocFixes({ markdown, catalog })[0]?.kind).toBe('vacuous');
  });
});

describe('against this repo', () => {
  test('the real reference page has a Fix column and this rule reads it', async () => {
    const found = await docFixGaps(repoRoot());
    expect(found.some((one) => one.kind === 'vacuous')).toBe(false);
  }, 20_000);

  test('the page carries far more Fix cells than any fixture', async () => {
    const page = await Bun.file(`${repoRoot()}/wiki/Error-Codes.md`).text();
    expect(readFixCells(page).length).toBeGreaterThan(300);
  });
});
