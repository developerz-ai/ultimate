// The walk: order, pins, floor, guards, report — and the installed CLI being many majors older.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { createUpgradeCommand } from './cmd-upgrade';
import {
  fixture,
  git,
  REQUIRED_BUN,
  recording,
  removeFixtures,
  run,
  VERIFY_GREEN,
  VERIFY_RED,
} from './cmd-upgrade-fixture';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

afterEach(removeFixtures);

describe('unit · x upgrade, the walk', () => {
  test('order is registry, pins, install, manifest, doctor, verify', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner);
    expect(spawned).toEqual([
      'pm view',
      'pm view',
      'install',
      'x manifest',
      'x doctor',
      'x verify',
    ]);
    expect(code).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.data).toMatchObject({
      from: '19.4.0',
      to: '20.1.0',
      next: '21.0.0',
      done: true,
      dryRun: false,
      section: {
        title: '19.x → 20.0.0, entry by entry',
        url: 'https://github.com/developerz-ai/ultimate/wiki/Upgrading#19x--2000-entry-by-entry',
      },
    });
    expect(output.data?.then).toContain('x upgrade --json');
    expect(output.data?.then).toContain('commit');
  });

  test('install runs after the pins are on disk, and every workspace is exact', async () => {
    const dir = await fixture();
    const base = recording();
    let atInstall: unknown;
    const runner: Runner = async (command, options) => {
      if (command[1] === 'install') atInstall = await Bun.file(join(dir, 'package.json')).json();
      return base.runner(command, options);
    };
    await run(dir, runner);
    expect(atInstall).toMatchObject({
      dependencies: { '@ultimat3/cli': '20.1.0', '@ultimat3/core': '20.1.0' },
    });
    const web = await Bun.file(join(dir, 'apps/web/package.json')).json();
    expect(web.dependencies).toEqual({ '@ultimat3/core': '20.1.0', sass: '^1.0.0' });
  });

  test('the Bun floor moves with the hop, and the digest is reported, untouched', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording().runner);
    expect(await Bun.file(join(dir, '.bun-version')).text()).toBe(`${REQUIRED_BUN}\n`);
    expect(await Bun.file(join(dir, '.github/workflows/ci.yml')).text()).toContain(
      `'${REQUIRED_BUN}'`,
    );
    const docker = await Bun.file(join(dir, 'docker/Dockerfile')).text();
    expect(docker).toContain('oven/bun:1.4-alpine AS deps');
    expect(docker).toContain('@sha256:d888c0 AS runtime');
    expect(output.data?.bun.from).toBe('>=1.3.0');
    expect(output.data?.bun.to).toBe(`>=${REQUIRED_BUN}`);
    expect(output.data?.bun.edited.map((edit) => edit.path).sort()).toEqual([
      '.bun-version',
      '.github/workflows/ci.yml',
      'docker/Dockerfile',
      'package.json',
    ]);
    expect(output.data?.bun.manual).toHaveLength(1);
    expect(output.data?.bun.manual[0]).toMatchObject({ path: 'docker/Dockerfile', line: 2 });
    const manifest = await Bun.file(join(dir, 'package.json')).json();
    expect(manifest.engines.bun).toBe(`>=${REQUIRED_BUN}`);
  });

  test('a differing guard is reported and its file unchanged', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording().runner);
    expect(output.data?.guards).toEqual({
      reported: true,
      missing: [{ name: 'no-eval', add: 'x g guard no-eval' }],
      differs: [{ name: 'no-raw-colors', refresh: 'x g guard no-raw-colors --force' }],
    });
    expect(await git(dir, 'diff', '--', 'guards/')).toBe('');
  });

  test('never commits: the hop is left for the agent to review', async () => {
    const dir = await fixture();
    await run(dir, recording().runner);
    expect((await git(dir, 'rev-list', '--count', 'HEAD')).trim()).toBe('1');
    expect(await git(dir, 'status', '--porcelain')).toContain('package.json');
  });

  test('a red gate exits non-zero with done false, every finding carried', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: VERIFY_RED, verifyCode: 1 });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.data?.done).toBe(false);
    expect(output.data?.verify).toEqual({
      ok: false,
      summary: '1 of 20 steps failed',
      failed: ['typecheck'],
      findings: [
        {
          step: 'typecheck',
          code: 'X_TYPECHECK_FAILED',
          cause: 'apps/web/a.ts(1,1): TS2322',
          fix: 'x verify --only typecheck',
          at: 'apps/web/a.ts',
        },
      ],
    });
    expect(output.data?.then).toContain('x verify --json');
  });

  test('the human form prints the url, then each finding and its fix', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: VERIFY_RED, verifyCode: 1 });
    const { code, lines } = await run(dir, runner, [], { json: false });
    const text = lines.join('\n');
    expect(code).toBe(1);
    const url = text.indexOf('wiki/Upgrading#19x--2000-entry-by-entry');
    const fix = text.indexOf('x verify --only typecheck');
    expect(url).toBeGreaterThan(-1);
    expect(fix).toBeGreaterThan(url);
    expect(text).toContain('X_TYPECHECK_FAILED');
    expect(text).toContain('x g guard no-raw-colors --force');
    expect(text).not.toContain('⟦');
  });
});

describe('unit · x upgrade, an installed CLI much older than this one', () => {
  test('a doctor with no guard listing is unknown, not none', async () => {
    const dir = await fixture();
    const { runner } = recording({ doctor: JSON.stringify({ ok: true, findings: [] }) });
    const { output } = await run(dir, runner);
    expect(output.data?.guards).toEqual({ reported: false, missing: [], differs: [] });
  });

  test('a boot log ahead of the document is read past', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: `ultimate migrate applied\n${VERIFY_GREEN}\n` });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(0);
    expect(output.data?.verify?.ok).toBe(true);
  });

  test('no JSON at all is a finding and a red hop, never a green', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: 'Segmentation fault\n', verifyCode: 139 });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(1);
    expect(output.data?.done).toBe(false);
    expect(output.data?.verify?.findings[0]?.code).toBe('X_UPGRADE_GATE_UNREADABLE');
    expect(output.data?.verify?.findings[0]?.fix).toContain('verify --json');
  });

  test('exit 1 under a document saying ok is red', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: VERIFY_GREEN, verifyCode: 1 });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(1);
    expect(output.data?.done).toBe(false);
  });

  test('a manifest that failed still runs the gate, and says so', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ manifestCode: 1 });
    const { output } = await run(dir, runner);
    expect(spawned).toContain('x verify');
    expect(output.data?.manifest?.ok).toBe(false);
  });
});

describe('unit · x upgrade, on stderr while it runs', () => {
  test('every stage is named, in order, and stdout stays the one document', async () => {
    const dir = await fixture();
    const stages: string[] = [];
    const command = createUpgradeCommand((line) => stages.push(line));
    const result = await command.run({
      args: parseArgs(['upgrade', '--json'], SPECS),
      cwd: dir,
      runner: recording().runner,
      env: {},
      bunVersion: REQUIRED_BUN,
    });
    expect(result.ok).toBe(true);
    expect(stages.map((line) => JSON.parse(line).upgrade)).toEqual([
      'install',
      'manifest',
      'doctor',
      'verify',
    ]);
  });
});
