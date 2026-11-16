// `issue-ledger.ts`: what the flake hunt and the compat matrix share — a resolved title closes its
// open issue and touches nothing else, a run with only resolved titles creates no label, and a
// refused close is a finding. The create/comment/reopen paths are pinned through
// `flake-hunt-file.test.ts`, which files through this module.

import { describe, expect, test } from 'bun:test';
import type { Ledger } from './issue-ledger';
import { fence, fileIssues, ledgerTitle } from './issue-ledger';
import type { RunResult } from './run';

const LEDGER: Ledger = {
  label: 'compat',
  color: '0e8a16',
  description: 'd',
  code: 'X_TEST_LEDGER_FAILED',
  fix: 'gh auth status',
  at: 'scripts/lib/issue-ledger.ts',
};

const ok = (output = ''): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});

const existing = JSON.stringify([
  { number: 9, title: 'compat: bun canary', state: 'OPEN' },
  { number: 3, title: 'compat: postgres 16', state: 'CLOSED' },
]);

const recording = (refuse?: string) => {
  const asked: string[] = [];
  const gh = async (args: readonly string[]): Promise<RunResult> => {
    asked.push(args.join(' '));
    if (refuse !== undefined && args[1] === refuse)
      return { ...ok('HTTP 502'), ok: false, code: 1 };
    return args[1] === 'list' ? ok(existing) : ok();
  };
  return { asked, gh };
};

describe('unit · issue ledger · a subject that went green', () => {
  test('closes its open issue, leaves a closed or unknown one alone, and creates no label', async () => {
    const { asked, gh } = recording();
    const resolved = [
      { title: 'compat: bun canary', body: 'green in run 1' },
      { title: 'compat: postgres 16', body: 'green' },
      { title: 'compat: solid 1', body: 'green' },
    ];
    const result = await fileIssues([], '.', LEDGER, gh, resolved);
    expect(result).toEqual({ filed: ['closed #9: compat: bun canary'], findings: [] });
    expect(asked).toEqual([
      'issue list --label compat --state all --limit 1000 --json number,title,state',
      'issue close 9 --comment green in run 1',
    ]);
  });

  test('files the red ones and closes the green ones from one list', async () => {
    const { asked, gh } = recording();
    await fileIssues([{ title: 'compat: postgres 16', body: 'red' }], '.', LEDGER, gh, [
      { title: 'compat: bun canary', body: 'green' },
    ]);
    expect(asked.slice(1)).toEqual([
      'issue list --label compat --state all --limit 1000 --json number,title,state',
      'issue reopen 3 --comment red',
      'issue close 9 --comment green',
    ]);
  });

  test('a refused close is a finding under the ledger’s own code', async () => {
    const { gh } = recording('close');
    const result = await fileIssues([], '.', LEDGER, gh, [
      { title: 'compat: bun canary', body: 'g' },
    ]);
    expect(result.findings.map((one) => [one.code, one.fix, one.at])).toEqual([
      ['X_TEST_LEDGER_FAILED', 'gh auth status', 'scripts/lib/issue-ledger.ts'],
    ]);
    expect(result.findings[0]?.cause).toContain('HTTP 502');
  });
});

describe('unit · issue ledger · titles and fences', () => {
  test('a title past GitHub’s length is cut the same way every time', () => {
    const long = ledgerTitle('x'.repeat(400));
    expect(long.length).toBe(240);
    expect(ledgerTitle('x'.repeat(400))).toBe(long);
    expect(ledgerTitle('short')).toBe('short');
  });

  test('a fence is one backtick longer than the longest run inside it', () => {
    expect(fence('text', 'a ```` b')).toBe('`````text\na ```` b\n`````');
    expect(fence('sh', 'plain')).toBe('```sh\nplain\n```');
  });
});
