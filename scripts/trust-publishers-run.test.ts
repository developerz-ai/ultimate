// `trustRun` over a fixture workspace tree and a scripted npm: each state a package can end in —
// already trusted, missing under `--check`, configured, denied by 2FA, failed — and the two
// refusals that stop the run before any verdict (an empty `--environment`, an npm with no `trust`).

import { describe, expect, test } from 'bun:test';
import { tempTree } from '../packages/testing/src/temp-tree';
import { parseScriptArgs } from './lib/args';
import type { RunResult } from './lib/run';
import { DEFAULT_ENVIRONMENT, DEFAULT_REPO, DEFAULT_WORKFLOW, trustRun } from './trust-publishers';

const PUBLISHER = JSON.stringify({
  repository: DEFAULT_REPO,
  workflow: DEFAULT_WORKFLOW,
  environment: DEFAULT_ENVIRONMENT,
});

/** Two publishable workspaces, core (tier 0) and jobs (tier 3), and one private app. */
async function seed(root: string): Promise<void> {
  await Bun.write(`${root}/package.json`, JSON.stringify({ name: 'fixture', private: true }));
  await Bun.write(
    `${root}/packages/core/package.json`,
    JSON.stringify({ name: '@ultimat3/core', version: '1.0.0' }),
  );
  await Bun.write(
    `${root}/packages/jobs/package.json`,
    JSON.stringify({ name: '@ultimat3/jobs', version: '1.0.0' }),
  );
  await Bun.write(
    `${root}/packages/app/package.json`,
    JSON.stringify({ name: 'app', version: '1.0.0', private: true }),
  );
}

interface Npm {
  /** `npm trust list <pkg>`'s answer per package; absent is a failed call with no output. */
  readonly list: Readonly<Record<string, string>>;
  /** `npm trust github <pkg>`'s answer per package: `true` attaches, a string is the failure. */
  readonly attach?: Readonly<Record<string, true | string>>;
}

function scripted(npm: Npm) {
  const calls: string[] = [];
  const answer = (command: readonly string[], ok: boolean, output: string): RunResult => ({
    command,
    code: ok ? 0 : 1,
    ok,
    output,
    durationMs: 1,
    timedOut: false,
  });
  return {
    calls,
    run: async (command: readonly string[]): Promise<RunResult> => {
      const [verb, name = ''] = command.slice(command.indexOf('trust') + 1);
      calls.push(`${verb} ${name}`);
      if (verb === 'list') {
        const listed = npm.list[name];
        return answer(command, listed !== undefined, listed ?? '');
      }
      const attached = npm.attach?.[name];
      return answer(command, attached === true, attached === true ? '' : (attached ?? 'boom'));
    },
  };
}

const trust = async (argv: readonly string[], npm: Npm) => {
  await using tree = tempTree('trust-run-');
  await seed(tree.path);
  const { run, calls } = scripted(npm);
  const result = await trustRun(parseScriptArgs(argv), { root: tree.path, run });
  return { result, calls };
};

const states = (data: unknown): readonly string[] =>
  (data as { outcomes: readonly { name: string; state: string }[] }).outcomes.map(
    (outcome) => `${outcome.name}=${outcome.state}`,
  );

describe('trustRun', () => {
  test('--check lists every publishable package, attaches nothing, and fails on the missing one', async () => {
    const { result, calls } = await trust(['--check'], {
      list: { '@ultimat3/core': PUBLISHER, '@ultimat3/jobs': '[]' },
    });
    expect(calls).toEqual(['list @ultimat3/core', 'list @ultimat3/jobs']);
    expect(states(result.data)).toEqual(['@ultimat3/core=already', '@ultimat3/jobs=missing']);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(`1/2 packages trust ${DEFAULT_REPO}/${DEFAULT_WORKFLOW}`);
  });

  test('without --check a missing publisher is attached; 2FA and other failures are told apart', async () => {
    const { result, calls } = await trust([], {
      list: {},
      attach: {
        '@ultimat3/core': true,
        '@ultimat3/jobs': 'npm ERR! code EOTP\nThis operation requires a one-time password',
      },
    });
    expect(calls).toEqual([
      'list @ultimat3/core',
      'github @ultimat3/core',
      'list @ultimat3/jobs',
      'github @ultimat3/jobs',
    ]);
    expect(states(result.data)).toEqual(['@ultimat3/core=configured', '@ultimat3/jobs=denied']);
    expect(result.ok).toBe(false);
  });

  test('a failure that is not 2FA is `failed`, with npm’s last line as its detail', async () => {
    const { result } = await trust(['--repo', 'someone/else'], {
      list: { '@ultimat3/core': PUBLISHER },
      attach: { '@ultimat3/core': 'npm ERR! 404\nnot found', '@ultimat3/jobs': true },
    });
    // The publisher npm lists is for the default repo, not the one asked for: re-attached.
    expect(states(result.data)).toEqual(['@ultimat3/core=failed', '@ultimat3/jobs=configured']);
    const outcomes = (result.data as { outcomes: readonly { detail: string }[] }).outcomes;
    expect(outcomes[0]?.detail).toBe('not found');
  });

  test('--dry-run calls npm for nothing and passes', async () => {
    const { result, calls } = await trust(['--dry-run'], { list: {} });
    expect(calls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(states(result.data)).toEqual(['@ultimat3/core=skipped', '@ultimat3/jobs=skipped']);
  });

  test('an empty --environment is refused before npm is asked anything', async () => {
    const { result, calls } = await trust(['--environment='], { list: {} });
    expect(calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_TRUST_ENVIRONMENT_EMPTY']);
  });

  test('an npm without `trust` stops the run at the first package', async () => {
    const { result, calls } = await trust(['--check'], {
      list: { '@ultimat3/core': 'Unknown command: "trust"' },
    });
    expect(calls).toEqual(['list @ultimat3/core']);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_TRUST_NPM_TOO_OLD']);
  });
});
