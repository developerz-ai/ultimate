// The weekly run of `ci.yml`: an idle default branch still gets gated, a scheduled run never touches
// the runs around it or publishes, and a red one reaches a person. The alarm's script is executed
// against a stand-in `gh`, because a workflow step is otherwise only ever tested in production.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, chmod or recursive remove.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no temp-directory primitive.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { YAML } from 'bun';
import { names } from '../naming';
import { CI_WORKFLOW_PATH, githubFiles } from './ci.yml';
import { ALARM_ISSUE_TITLE, weeklyCron } from './ci-schedule';
import { DEFAULT_RUNNER } from './runner';

interface Step {
  readonly run?: string;
  readonly uses?: string;
  readonly shell?: string;
  readonly env?: Readonly<Record<string, string>>;
}
interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly 'runs-on'?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on?: { readonly schedule?: readonly { readonly cron?: string }[] };
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: unknown };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

const text = (path: string, app = 'ledger-demo'): string =>
  String(githubFiles(names(app)).find((file) => file.path === path)?.contents);
const workflow = (app?: string): Workflow => YAML.parse(text(CI_WORKFLOW_PATH, app)) as Workflow;
const alarm = (): Job => workflow().jobs?.['alarm'] ?? expect.unreachable('no alarm job');
const expr = (body: string): string => ['$', '{{ ', body, ' }}'].join('');

describe('unit · the weekly run of the CI workflow', () => {
  test('it fires once a week, off the hour, at a minute the app name picks', () => {
    const crons = workflow().on?.schedule?.map((entry) => entry.cron) ?? [];
    expect(crons).toEqual([weeklyCron('ledger-demo')]);
    expect(weeklyCron('ledger-demo')).toMatch(/^([1-9]|[1-5]\d) 4 \* \* 0$/);
    expect(weeklyCron('ledger-demo')).toBe(weeklyCron('ledger-demo'));
    const minutes = ['a', 'shop', 'ledger-demo', 'blog', 'crm', 'notes', 'forum', 'wiki'].map(
      (app) => weeklyCron(app).split(' ')[0],
    );
    expect(new Set(minutes).size).toBeGreaterThan(4);
    for (const minute of minutes) expect(['0', '59']).not.toContain(minute);
  });

  // `github.event.repository` is not a field to lean on under `schedule`, so the schedule arm decides
  // first; its own run id means no other run shares the group, in either direction.
  test('a scheduled run is alone in its concurrency group', () => {
    const group = workflow().concurrency?.group ?? '';
    expect(group.startsWith(`ci-$`)).toBe(true);
    expect(group).toContain(
      "{{ github.event_name == 'schedule' && format('schedule-{0}', github.run_id) || github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && github.sha || github.ref }}",
    );
  });

  test('the plan job runs on everything but a same-repository pull request', () => {
    expect(workflow().jobs?.['plan']?.if).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository",
    );
  });

  test('the image workflow still publishes a push alone, so a scheduled run ships nothing', () => {
    const image = YAML.parse(text('.github/workflows/image.yml')) as Workflow;
    expect(image.jobs?.['publish']?.if).toContain("github.event.workflow_run.event == 'push'");
    expect(Object.keys(workflow().jobs ?? {})).toEqual(['plan', 'gate', 'verify', 'alarm']);
  });
});

describe('unit · the alarm a scheduled run raises', () => {
  test('it runs after the verdict, red or green, on a schedule and on nothing else', () => {
    expect(alarm().needs).toBe('verify');
    expect(alarm().if).toBe(expr("!cancelled() && github.event_name == 'schedule'"));
  });

  // The workflow-level grant stays read-only; a job's `permissions` replaces it, so this job can
  // reach issues and nothing else. No checkout, no install: no third-party code beside the token.
  test('it alone holds issues: write, runs no action and no code of the repository', () => {
    expect(workflow().permissions).toEqual({ contents: 'read' });
    expect(alarm().permissions).toEqual({ issues: 'write' });
    for (const name of ['plan', 'gate', 'verify']) {
      expect(workflow().jobs?.[name]?.permissions).toBeUndefined();
    }
    expect(alarm().steps?.filter((step) => step.uses !== undefined)).toEqual([]);
    expect(alarm()['runs-on']).toBe(DEFAULT_RUNNER);
  });

  // zizmor's template-injection: every value reaches the script through `env:`.
  test('its script holds no expression', () => {
    const step = alarm().steps?.[0];
    expect(step?.run).not.toContain('{{');
    expect(step?.env?.['VERDICT']).toBe(expr('needs.verify.result'));
    expect(step?.env?.['GH_TOKEN']).toBe(expr('github.token'));
    expect(step?.env?.['GH_REPO']).toBe(expr('github.repository'));
  });
});

/** `gh` as a script: logs each call, answers from the scenario's env. */
const FAKE_GH = `#!/usr/bin/env bash
all="$*"
printf '%s\\n' "\${all//$'\\n'/ }" >> "$GH_LOG"
case "$1 $2" in
  'repo view') printf '%s\\n' "$FAKE_ISSUES_ON" ;;
  'issue list') [ -z "$FAKE_LIST_FAILS" ] || exit 1; printf '%s' "$FAKE_OPEN" ;;
esac
`;

describe.skipIf(process.platform === 'win32')('unit · the alarm script, executed', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const run = async (scenario: {
    readonly verdict: string;
    readonly open?: string;
    readonly issuesOn?: string;
    readonly listFails?: boolean;
  }) => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-alarm-'));
    dirs.push(dir);
    await Bun.write(join(dir, 'gh'), FAKE_GH);
    await chmod(join(dir, 'gh'), 0o755);
    const log = join(dir, 'calls.log');
    await Bun.write(log, '');
    const script = alarm().steps?.[0]?.run ?? expect.unreachable('no alarm script');
    const child = Bun.spawn(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        GH_LOG: log,
        VERDICT: scenario.verdict,
        FAKE_OPEN: scenario.open ?? '',
        FAKE_ISSUES_ON: scenario.issuesOn ?? 'true',
        FAKE_LIST_FAILS: scenario.listFails === true ? '1' : '',
        GITHUB_SERVER_URL: 'https://github.example',
        GITHUB_REPOSITORY: 'acme/shop',
        GITHUB_RUN_ID: '42',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const calls = (await Bun.file(log).text()).split('\n').filter((line) => line !== '');
    return {
      code,
      stdout,
      lookup: calls.find((line) => line.startsWith('issue list')),
      writes: calls.filter((line) => !/^(repo view|issue list)/.test(line)),
    };
  };

  const RUN_URL = 'https://github.example/acme/shop/actions/runs/42';

  test('a red run with no open issue opens one, naming the run', async () => {
    const { code, writes } = await run({ verdict: 'failure' });
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith(`issue create --title ${ALARM_ISSUE_TITLE} --body `);
    expect(writes[0]).toContain(RUN_URL);
  });

  // `skipped` is the verdict job when the plan died: still no verdict, still an alarm.
  test('a verdict that never ran is red too', async () => {
    const { writes } = await run({ verdict: 'skipped' });
    expect(writes[0]).toStartWith('issue create ');
  });

  test('a red run with the issue open comments on it, and opens no second', async () => {
    const { writes } = await run({ verdict: 'failure', open: '7' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith('issue comment 7 --body ');
    expect(writes[0]).toContain(RUN_URL);
  });

  test('a green run closes the open issue', async () => {
    const { writes } = await run({ verdict: 'success', open: '7' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith('issue close 7 --reason completed --comment ');
  });

  test('a green run with nothing open writes nothing', async () => {
    expect((await run({ verdict: 'success' })).writes).toEqual([]);
  });

  // Otherwise a repository with Issues off would turn every green week red.
  test('Issues switched off is a warning, never a red alarm job', async () => {
    const { code, stdout, writes } = await run({ verdict: 'success', issuesOn: 'false' });
    expect(code).toBe(0);
    expect(stdout).toContain('::warning::');
    expect(writes).toEqual([]);
  });

  // Anyone can open an issue under this title: only the workflow's own is ever written to.
  test('the lookup is open issues by this workflow’s bot, matched on the whole title', async () => {
    const { lookup } = await run({ verdict: 'failure' });
    expect(lookup).toContain('--state open');
    expect(lookup).toContain('--author app/github-actions');
    expect(lookup).toContain(`select(.title == "${ALARM_ISSUE_TITLE}")`);
  });

  test('a lookup that fails fails the job, rather than filing a duplicate', async () => {
    const { code, writes } = await run({ verdict: 'failure', listFails: true });
    expect(code).not.toBe(0);
    expect(writes).toEqual([]);
  });
});
