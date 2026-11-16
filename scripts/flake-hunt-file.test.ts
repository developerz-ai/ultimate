// `flake-hunt-file.ts`: the rounds' failures grouped into one issue per test under a stable title,
// and the `gh` calls that file them over an injected runner — an open issue gets a comment, a
// closed one is reopened, an unknown one is created, and a refused call is a finding, never silent.

import { describe, expect, test } from 'bun:test';
import { fileIssues, issuesFor, LABEL } from './flake-hunt-file';
import type { RoundDoc } from './flake-hunt-round';
import type { RunResult } from './lib/run';

const round = (over: Partial<RoundDoc>): RoundDoc => ({
  suite: 'unit',
  seed: 11,
  round: 1,
  ok: false,
  failures: [],
  findings: [],
  rerun: 'bun run x -- test unit -- --randomize --seed=11',
  tail: '',
  ...over,
});

const flake = { file: 'packages/core/src/a.test.ts', test: 'a > adds', excerpt: 'Expected: 1' };

describe('unit · flake-hunt · issuesFor', () => {
  test('one issue per test across rounds, every seed it failed under in the body', () => {
    const plans = issuesFor(
      [
        round({ failures: [flake] }),
        round({ round: 2, seed: 12, failures: [flake], rerun: 'R2' }),
        round({ round: 3, ok: true }),
      ],
      'https://example.test/run/1',
    );
    expect(plans.map((plan) => plan.title)).toEqual([
      'flake: packages/core/src/a.test.ts > a > adds',
    ]);
    const body = plans[0]?.body ?? '';
    for (const needle of [
      'seed=11',
      'R2',
      '| unit | 2 | 12 |',
      'bun test ./packages/core/src/a.test.ts --randomize --seed=11',
      'Expected: 1',
      'https://example.test/run/1',
    ]) {
      expect(body).toContain(needle);
    }
  });

  test('a red round that named no test files under its suite, with the tail of its output', () => {
    const plans = issuesFor([round({ suite: 'live', tail: 'Segmentation fault' })], undefined);
    expect(plans.map((plan) => plan.title)).toEqual([
      'flake: live run red with no failing test named',
    ]);
    expect(plans[0]?.body).toContain('Segmentation fault');
  });

  test('a green night files nothing', () => {
    expect(issuesFor([round({ ok: true })], undefined)).toEqual([]);
  });

  test('a title past GitHub’s length is cut the same way every night', () => {
    const long = { ...flake, test: 'x'.repeat(400) };
    const [first] = issuesFor([round({ failures: [long] })], undefined);
    const [again] = issuesFor([round({ failures: [long] })], undefined);
    expect(first?.title.length).toBeLessThanOrEqual(240);
    expect(first?.title).toBe(again?.title ?? '');
  });

  test('an excerpt holding a fence of its own stays inside a longer one: no mention escapes', () => {
    const excerpt = 'before\n````\n@scope/x was here\n`````\nafter';
    const [plan] = issuesFor([round({ failures: [{ ...flake, excerpt }] })], undefined);
    const body = plan?.body ?? '';
    // Six backticks open and close it: one more than the longest run the output holds.
    expect(body).toContain(`\`\`\`\`\`\`text\n${excerpt}\n\`\`\`\`\`\``);
    // An ordinary excerpt keeps the plain three.
    const [plain] = issuesFor([round({ failures: [flake] })], undefined);
    expect(plain?.body).toContain('```text\nExpected: 1\n```');
  });

  test('a test file path a shell would read as code is never pasted into the rerun line', () => {
    const file = 'packages/core/src/$(touch pwned).test.ts';
    const [plan] = issuesFor([round({ failures: [{ ...flake, file }] })], undefined);
    expect(plan?.body).not.toContain('$(touch pwned)');
    expect(plan?.body).toContain('bun test <the failing test file> --randomize --seed=11');
  });
});

const ok = (output = ''): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});
const refused = (output: string): RunResult => ({ ...ok(output), code: 1, ok: false });

describe('unit · flake-hunt · fileIssues', () => {
  test('nothing to file asks gh nothing', async () => {
    let asked = 0;
    const gh = async (): Promise<RunResult> => {
      asked += 1;
      return ok();
    };
    expect(await fileIssues([], '.', gh)).toEqual({ filed: [], findings: [] });
    expect(asked).toBe(0);
  });

  const plans = [
    { title: 'flake: open', body: 'b1' },
    { title: 'flake: closed', body: 'b2' },
    { title: 'flake: new', body: 'b3' },
  ];
  const existing = JSON.stringify([
    { number: 4, title: 'flake: open', state: 'OPEN' },
    { number: 2, title: 'flake: closed', state: 'CLOSED' },
  ]);

  test('comments on the open issue, reopens the closed one, creates the unknown one', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(args.join(' '));
      return args[0] === 'issue' && args[1] === 'list' ? ok(existing) : ok();
    };
    const result = await fileIssues(plans, '.', gh);
    expect(result.findings).toEqual([]);
    expect(asked).toEqual([
      expect.stringMatching(new RegExp(`^label create ${LABEL} `)),
      `issue list --label ${LABEL} --state all --limit 1000 --json number,title,state`,
      'issue comment 4 --body b1',
      'issue reopen 2 --comment b2',
      `issue create --label ${LABEL} --title flake: new --body b3`,
    ]);
  });

  test('an existing label is confirmed through the API, not read as a failure', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(args.join(' '));
      if (args[0] === 'label') return refused('already exists');
      return args[1] === 'list' ? ok('[]') : ok();
    };
    const result = await fileIssues([{ title: 'flake: new', body: 'b' }], '.', gh);
    expect(result.findings).toEqual([]);
    expect(asked[1]).toBe(`api repos/{owner}/{repo}/labels/${LABEL}`);
  });

  test('a refused gh call is a finding, and the other issues are still filed', async () => {
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      if (args[1] === 'list') return ok(existing);
      return args[1] === 'comment' ? refused('HTTP 502') : ok();
    };
    const result = await fileIssues(plans, '.', gh);
    expect(result.findings.map((one) => one.code)).toEqual(['X_FLAKE_HUNT_FILE_FAILED']);
    expect(result.findings[0]?.cause).toContain('HTTP 502');
    expect(result.filed).toEqual(['reopened #2: flake: closed', 'created: flake: new']);
  });

  test('an issue list that is no JSON refuses before anything is filed', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(args.join(' '));
      return args[1] === 'list' ? ok('not json') : ok();
    };
    const result = await fileIssues(plans, '.', gh);
    expect(result.findings.map((one) => one.code)).toEqual(['X_FLAKE_HUNT_FILE_FAILED']);
    expect(asked).toHaveLength(2);
  });
});
