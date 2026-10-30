// Pin the health brief's closed, ordered table to its machine definitions; mutations must fail
// the same assertions as the real document, without rewriting documentation on disk.

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { ROW_COMMANDS } from '../health';
import { ROW_IDS, type RowId } from './health-rule';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const SIGNAL_IDS = new Map<string, RowId>([
  ['`main` is green', 'main-green'],
  ['the last tag published', 'last-tag-published'],
  ['the stamped version is tagged', 'stamped-version-tagged'],
  ['tag runs ended well', 'tag-runs-ended-well'],
  ['npm serves what the tree says', 'npm-serves-tree'],
  ["automation's own alarms", 'automation-alarms'],
  ['Dependabot is not stuck', 'dependabot-not-stuck'],
  ['the deployed demo shipped', 'demo-shipped'],
  ['the GitHub Release exists', 'release-exists'],
]);

/** A command that assigns: the whole inline span is `name=$(...)`. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=\$\((.*)\)$/;

/** A command that reads a variable: `$name`, quoted or not. */
const REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Every variable a row's command reads must be assigned by that same row's command before the
 * read: the strip below erases the assignment's name, so a renamed assignment (`sha=$(...)`
 * where the command still reads `"$t"`) normalizes to the same command while the shell reads an
 * unset variable.
 */
function assertAssignmentsPairWithReferences(spans: readonly string[]): void {
  const assigned: string[] = [];
  for (const span of spans) {
    for (const match of span.matchAll(REFERENCE)) {
      const name = match[1] ?? '';
      expect(assigned, `command reads an unassigned variable: $${name}`).toContain(name);
    }
    const assignment = ASSIGNMENT.exec(span);
    if (assignment !== null) assigned.push(assignment[1] ?? '');
  }
}

function normalizedCommand(cell: string): string {
  // Only the leading instruction is executable; the em-dash suffix explains it and can contain
  // other inline spans (for example Dependabot's bound). Never strip arguments from a command.
  const instruction = cell.split(' — ')[0] ?? '';
  expect(instruction).toMatch(/^`[^`]+`(?:(?:, then |; )`[^`]+`)*$/);
  const spans = [...instruction.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  assertAssignmentsPairWithReferences(spans);
  return spans
    .map((span) => span.replace(/^(?:t|sha)=\$\((.*)\)$/, '$1').replaceAll('"$t"', '<tag>'))
    .join('; ');
}

function assertBrief(brief: string): void {
  const lines = brief.split('\n');
  const header = '| Signal | Command | Healthy |';
  expect(lines.filter((line) => line === header)).toHaveLength(1);
  const start = lines.indexOf(header);
  expect(lines[start + 1]).toMatch(/^\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|$/);
  const ids: RowId[] = [];
  for (const line of lines.slice(start + 2)) {
    if (line.trim() === '') break;
    const cells = /^\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/.exec(line);
    expect(cells, `malformed health row: ${line}`).not.toBeNull();
    if (cells === null) expect.unreachable('malformed health row');
    const signal = cells[1] ?? '';
    const id = SIGNAL_IDS.get(signal);
    expect(id, `unknown health signal: ${signal}`).toBeDefined();
    if (id === undefined) expect.unreachable('unknown health signal');
    expect(ids, `duplicate health signal: ${signal}`).not.toContain(id);
    ids.push(id);
    expect(cells[3], `missing healthy condition: ${signal}`).not.toBe('');
    expect(normalizedCommand(cells[2] ?? ''), signal).toBe(ROW_COMMANDS[id]);
  }
  expect(ids).toEqual([...ROW_IDS]);
}

/** A `## Rows` item: a bullet whose leading backticked span is the row id. */
const ROW_ITEM = /^- `([^`]+)`/;

/** A row id: lowercase letters, digits, hyphens or underscores, at most forty characters. */
const ROW_ID_SHAPE = /^[a-z0-9_-]{1,40}$/;

interface RowsSection {
  /** The index of the `## Rows` heading. */
  readonly start: number;
  /** The index of the section's last item line. */
  readonly end: number;
  /** The section's item lines, in document order. */
  readonly items: readonly string[];
}

/**
 * The brief's `## Rows` section: the heading once, then the item lines under it, up to the next
 * level-2 heading. Blank lines and the file's trailing marker are not items.
 */
function rowsSection(brief: string): RowsSection {
  const lines = brief.split('\n');
  const heading = '## Rows';
  expect(lines.filter((line) => line === heading)).toHaveLength(1);
  const start = lines.indexOf(heading);
  expect(start, 'the brief must carry a `## Rows` section').toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => line.startsWith('## '));
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const items: string[] = [];
  const indexes: number[] = [];
  for (const [offset, line] of body.entries()) {
    if (line.trim() === '' || line.startsWith('<!--')) continue;
    expect(line, `malformed Rows item: ${line}`).toMatch(ROW_ITEM);
    items.push(line);
    indexes.push(start + 1 + offset);
  }
  const end = indexes[indexes.length - 1] ?? start;
  return { start, end, items };
}

/**
 * The brief's Rows section must name every row the machine reports — once each, in the table's
 * order, each id shaped like a row id. A brief that names a row the machine never reports (or
 * drops one it does) is a second definition of the table, which the brief forbids.
 */
function assertRowsSection(brief: string): void {
  const ids = rowsSection(brief).items.map((item) => {
    const match = ROW_ITEM.exec(item);
    expect(match, `malformed Rows item: ${item}`).not.toBeNull();
    if (match === null) expect.unreachable('malformed Rows item');
    return match[1] ?? '';
  });
  for (const id of ids) {
    expect(id, `row id must be lowercase, digits, hyphens or underscores: ${id}`).toMatch(
      ROW_ID_SHAPE,
    );
  }
  expect(new Set(ids).size, `duplicate row ids: ${ids.join(', ')}`).toBe(ids.length);
  expect(ids, 'the Rows section must name every row, once each, in the table order').toEqual([
    ...ROW_IDS,
  ]);
}

/** One of the brief's Rows items by id — the fifth, so dropping it is not the tail's loss. */
function rowItem(brief: string): string {
  const item = rowsSection(brief).items.find((line) => line.startsWith('- `npm-serves-tree`'));
  expect(item, 'the brief must list the npm-serves-tree row').toBeDefined();
  if (item === undefined) expect.unreachable('the npm-serves-tree row is missing');
  return item;
}

let brief: string;
beforeAll(async () => {
  brief = await Bun.file(join(repoRoot(), '.dz/briefs/health.md')).text();
});

function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from), `mutation target must occur exactly once: ${from}`).toHaveLength(2);
  return text.replace(from, to);
}

describe('unit · health-doc · the brief matches the ordered machine definitions', () => {
  test('all nine signal identities and full commands agree', () => {
    assertBrief(brief);
  });

  test.each([
    ['deleted', (row: string) => ''],
    ['duplicated', (row: string) => `${row}\n${row}`],
    ['inserted unknown', (row: string) => `${row}\n| new signal | \`new command\` | healthy |`],
    ['renamed', (row: string) => row.replace('tag runs ended well', 'tag runs went well')],
    ['malformed', (row: string) => row.slice(0, -1)],
    ['empty healthy condition', (row: string) => `${row.split('|').slice(0, 3).join('|')}| |`],
  ])('rejects a %s row', (_name, mutate) => {
    const row = brief.split('\n').find((line) => line.startsWith('| tag runs ended well |'));
    expect(row).toBeDefined();
    if (row === undefined) expect.unreachable('mutation row missing');
    const altered = replaceOnce(brief, row, mutate(row));
    expect(() => assertBrief(altered)).toThrow();
  });

  test('rejects reordered rows', () => {
    const rows = brief.split('\n').filter((line) => line.startsWith('|'));
    const first = rows[2];
    const second = rows[3];
    if (first === undefined || second === undefined) expect.unreachable('mutation rows missing');
    const altered = replaceOnce(brief, `${first}\n${second}`, `${second}\n${first}`);
    expect(() => assertBrief(altered)).toThrow();
  });

  test.each([
    [
      'limit prefix',
      '--workflow release-tag.yml --limit 5',
      '--workflow release-tag.yml --limit 50',
    ],
    ['missing flag', '--app dependabot --limit 5 --state open', '--app dependabot --limit 5'],
    ['changed argument', '--label registry-drift --json', '--label other-alarm --json'],
    [
      'missing JSON field',
      '--json number,title,state,createdAt,updatedAt,url',
      '--json number,title',
    ],
    [
      'extra JSON field',
      '--json tagName,isDraft,publishedAt`',
      '--json tagName,isDraft,publishedAt,url`',
    ],
    ['command suffix', 'git rev-parse origin/main` |', 'git rev-parse origin/main --short` |'],
  ])('rejects command drift: %s', (_name, from, to) => {
    const altered = replaceOnce(brief, from, to);
    expect(() => assertBrief(altered)).toThrow();
  });

  test('rejects a renamed tag assignment whose reference is left behind', () => {
    const row = brief.split('\n').find((line) => line.startsWith('| the last tag published |'));
    expect(row).toBeDefined();
    if (row === undefined) expect.unreachable('mutation row missing');
    const altered = replaceOnce(brief, row, row.replace('`t=$(', '`sha=$('));
    expect(() => assertBrief(altered)).toThrow(/unassigned variable: \$t/);
  });

  test('the Rows section names every row id, once each, in order', () => {
    assertRowsSection(brief);
  });

  test.each([
    [
      'a deleted section',
      (text: string): string => {
        const section = rowsSection(text);
        const lines = text.split('\n');
        return [...lines.slice(0, section.start), ...lines.slice(section.end + 1)].join('\n');
      },
    ],
    ['a dropped item', (text: string): string => replaceOnce(text, rowItem(text), '')],
    [
      'a duplicated item',
      (text: string): string => {
        const item = rowItem(text);
        return replaceOnce(text, item, `${item}\n${item}`);
      },
    ],
    ['a retyped id', (text: string): string => replaceOnce(text, '`main-green`', '`main-red`')],
    ['a malformed id', (text: string): string => replaceOnce(text, '`main-green`', '`Main Green`')],
  ])('rejects %s', (_name, mutate) => {
    const altered = mutate(brief);
    expect(altered, 'the mutation must change the brief').not.toBe(brief);
    expect(() => assertRowsSection(altered)).toThrow();
  });
});
