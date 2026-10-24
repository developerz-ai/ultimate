// The docs that describe the release-due rule must describe it exactly. Two of them: the brief's
// decision table (.dz/briefs/release-due.md), whose reason-keyed rows are the checkup's only
// branch point, and PUBLISHING.md's due-decision envelope table, the maintainer's view of
// `DueDecision`. A row losing its field, a table growing one, or a row that loses the command it
// prescribes must red here rather than ship a doc that misdescribes what the rule does. Split from
// `release-due-rule.test.ts`, which owns the rule's behaviour, so the doc pins are not also the
// file that computes a decision.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { AWAITING_TAG_COMMAND, majorIssueArgs, NOT_DUE_REASONS } from './release-due-rule';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Reads two pinned files in the real tree, so the repo-scan guard (scripts/repo-scan-timeout.test.ts)
// holds this file to the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · release-due-doc · the brief covers the closed list', () => {
  // The brief's decision table is the checkup's only branch point on `data.reason`, so its
  // reason-keyed not-due rows must equal `NOT_DUE_REASONS` exactly: a reason losing its row, or
  // the table growing a reason the rule never returns, must red here rather than send the bot
  // off-table in production. The `X_RELEASE_HEAD_NOT_MAIN` row keys a findings code, not a
  // `NOT_DUE_REASONS` entry — its second cell carries `(in findings)` after the token, so the row
  // regex below passes it over and the pin holds at four.
  test('one brief row per reason, and awaiting_tag pins its watch command', async () => {
    const brief = await Bun.file(join(repoRoot(), '.dz/briefs/release-due.md')).text();
    const falseRows = brief.split('\n').filter((line) => line.startsWith('| `false` |'));
    const reasons = falseRows
      .map((line) => /^\| `false` \| `([^`]+)` \|/.exec(line)?.[1])
      .filter((reason): reason is string => reason !== undefined);
    expect([...reasons].sort()).toEqual([...NOT_DUE_REASONS].sort());
    const awaitingTag = falseRows.find((line) => line.startsWith('| `false` | `awaiting_tag` |'));
    // The row is the whole instruction for this reason, so the pin is on its payload — the
    // command to watch and the verdict to file nothing — not merely on the row's existence.
    // The command is pinned with its backtick delimiters: a bare substring would survive a
    // changed limit, since `--limit 50` contains `--limit 5`.
    expect(awaitingTag, 'the awaiting_tag row vanished from the brief').toBeDefined();
    // The command is pinned with its backtick delimiters: a bare substring would survive a
    // changed limit, since `--limit 50` contains `--limit 5`. The whole payload is pinned too —
    // the `--json` field list is what makes the query return filing evidence (the run's status and
    // conclusion, its id, its title, the commit it ran at, its URL and when it was created), so
    // the brief's row must carry exactly the command the rule emits.
    expect(awaitingTag).toContain(`\`${AWAITING_TAG_COMMAND}\``);
    expect(awaitingTag).toContain(
      '`gh run list --workflow release-tag.yml --limit 5 --json status,conclusion,databaseId,displayTitle,headSha,url,createdAt`',
    );
    expect(awaitingTag).toContain('nothing');

    // The major row is the whole instruction for this reason too, so its payload is pinned: the
    // command that checks whether a pending-major issue is already open, and the inputs it
    // branches on. A row that only said "unless no open issue already says a major is pending"
    // left the box to invent the check.
    const majorRow = falseRows.find((line) =>
      line.startsWith('| `false` | `major_needs_a_maintainer` |'),
    );
    expect(majorRow, 'the major_needs_a_maintainer row vanished from the brief').toBeDefined();
    const majorCommand = majorIssueArgs('28.0.0');
    const majorSearch = majorCommand[majorCommand.indexOf('--search') + 1];
    expect(majorSearch).toBe('Major release pending: 28.0.0 in:title');
    // The command is pinned with its backtick delimiters, so a changed query cannot slip past a
    // substring check.
    expect(majorRow).toContain(
      `\`gh issue list --state open --search "Major release pending: <next> in:title" --json number,title\``,
    );
    // The inputs the row branches on: the version the issue is keyed by, and the breaking list
    // the issue body carries.
    expect(majorRow).toContain('`data.next`');
    expect(majorRow).toContain('`data.breaking`');
  });
});

describe('unit · release-due-doc · the envelope table tracks DueDecision', () => {
  // The fields are parsed from the rule's source, not imported — an import cannot catch a field
  // the interface lost.
  test('one envelope row per field, and breaking names the maintainer issue', async () => {
    const source = await Bun.file(join(repoRoot(), 'scripts/lib/release-due-rule.ts')).text();
    const start = source.indexOf('export interface DueDecision {');
    expect(start, 'DueDecision vanished from release-due-rule.ts').toBeGreaterThanOrEqual(0);
    const interfaceLines = source.slice(start).split('\n');
    const close = interfaceLines.findIndex((line) => line === '}');
    expect(close, 'DueDecision never closes').toBeGreaterThan(0);
    const body = interfaceLines.slice(0, close).join('\n');
    const fields = [...body.matchAll(/^\s{2}readonly ([a-z][a-zA-Z0-9]*)/gm)]
      .map((match) => match[1])
      .filter((field): field is string => field !== undefined);
    expect(fields.length, 'DueDecision parsed to no fields').toBeGreaterThan(0);
    expect(new Set(fields).size, 'a duplicate field in DueDecision').toBe(fields.length);

    const doc = await Bun.file(join(repoRoot(), 'PUBLISHING.md')).text();
    const docLines = doc.split('\n');
    const table = docLines.findIndex((line) => line.startsWith('| `.data` field |'));
    expect(table, 'the envelope table vanished from PUBLISHING.md').toBeGreaterThanOrEqual(0);
    const rowKeys: string[] = [];
    for (let index = table + 1; index < docLines.length; index += 1) {
      const line = docLines[index];
      if (line === undefined || !line.startsWith('|')) break;
      const key = /^\| `([a-z][a-zA-Z0-9]*)` \|/.exec(line)?.[1];
      if (key !== undefined) rowKeys.push(key);
    }
    expect(rowKeys.length, 'the envelope table parsed to no rows').toBeGreaterThan(0);
    expect(new Set(rowKeys).size, 'a duplicate row in the envelope table').toBe(rowKeys.length);
    expect([...fields].sort()).toEqual([...rowKeys].sort());
    expect([...rowKeys].sort()).toEqual([...fields].sort());

    const breakingRow = docLines.find((line) => line.startsWith('| `breaking` |'));
    expect(breakingRow, 'the breaking row vanished from the envelope table').toBeDefined();
    expect(breakingRow).toContain('| array |');
    expect(breakingRow).toContain('maintainer issue');
  });
});
