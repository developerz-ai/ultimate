// The failure case first: a reference row whose Fix cell names a command this build refuses. Then
// the two ways this rule stops being one — a page that is gone, and a page whose tables no longer
// declare a Fix column at all, either of which would otherwise read as "every fix is runnable".

import { describe, expect, test } from 'bun:test';
import type { CommandCatalog } from '@ultimat3/cli';
import { checkDocFixes, docFixFindingFor, docFixGaps, readFixCells } from './doc-fixes';
import { repoRoot } from './lib/run';

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
