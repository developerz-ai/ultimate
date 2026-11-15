// A hop stopped between its pin write and its gate (M3): the pins say "at target", so a rerun used to
// answer done with no install and no gate. `.x/upgrade.json` records the hop until its gate
// returns; a rerun that finds it at target installs and gates, and a dirty tree says stash.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdir.
import { mkdirSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fixture, git, recording, removeFixtures, run } from './cmd-upgrade-fixture';
import type { Runner } from './exec';
import { UPGRADE_LOCK_FILE } from './upgrade-lock';
import { UNFINISHED_FILE } from './upgrade-unfinished';
import { STEP_TAG_ENV } from './verify-deadline';

afterEach(removeFixtures);

const TO = ['--to', '20.1.0'];

/** A hop that writes its pins and dies at `bun install`: the record outlives it. */
const interrupted = async (): Promise<string> => {
  const dir = await fixture();
  const { output } = await run(dir, recording({ installCode: 1 }).runner, TO);
  expect(output.findings?.[0]?.code).toBe('X_UPGRADE_INSTALL_FAILED');
  return dir;
};

describe('unit · x upgrade, a hop stopped after its pins land', () => {
  test('the record names the hop until the gate returns, and a finished hop leaves none', async () => {
    const dir = await interrupted();
    const record = (await Bun.file(join(dir, UNFINISHED_FILE)).json()) as Record<string, unknown>;
    expect(record).toMatchObject({ from: '19.4.0', to: '20.1.0' });

    const clean = await fixture();
    const { code } = await run(clean, recording().runner, TO);
    expect(code).toBe(0);
    expect(await Bun.file(join(clean, UNFINISHED_FILE)).exists()).toBe(false);
  });

  test('the dirty tree it leaves is refused with stash, never commit', async () => {
    const dir = await interrupted();
    const { runner, spawned } = recording();
    const { output } = await run(dir, runner, TO);
    expect(spawned).toEqual([]);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_DIRTY_TREE');
    expect(output.findings?.[0]?.cause).toContain('20.1.0');
    expect(output.findings?.[0]?.fix).toStartWith('git stash push --include-untracked');
    expect(output.findings?.[0]?.fix).not.toContain('commit');
  });

  test('committed anyway, the rerun at target installs and runs the whole gate, then clears it', async () => {
    const dir = await interrupted();
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'half a hop');
    const { runner: scripted, spawned } = recording();
    const argv: string[][] = [];
    const runner: Runner = (command, options) => {
      argv.push([...command]);
      return scripted(command, options);
    };
    const { code, output } = await run(dir, runner, TO);
    expect(code).toBe(0);
    expect(spawned).toContain('install');
    // Every codemod up to the target: which of them the stopped hop already ran is not recorded.
    const codemods = argv.find((command) => command.includes('codemods'));
    expect(codemods?.[codemods.indexOf('--from') + 1]).toBe('0.0.0');
    expect(spawned).toContain('x upgrade');
    expect(spawned).toContain('x verify');
    expect(output.data?.from).toBe('19.4.0');
    expect(output.data?.to).toBe('20.1.0');
    expect(output.data?.done).toBe(true);
    expect(output.data?.proof).toBe('verify');
    expect(await Bun.file(join(dir, UNFINISHED_FILE)).exists()).toBe(false);

    // And the run after that is an ordinary at-target run: no install, no gate.
    const again = recording();
    await run(dir, again.runner, TO);
    expect(again.spawned).not.toContain('install');
  });

  test('a red gate on the resumed hop still clears the record: the hop finished, red', async () => {
    const dir = await interrupted();
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'half a hop');
    const { code, output } = await run(
      dir,
      recording({
        verifyCode: 1,
        verify: '{"ok":false,"command":"verify","summary":"red","steps":[]}',
      }).runner,
      TO,
    );
    expect(code).toBe(1);
    expect(output.data?.done).toBe(false);
    expect(await Bun.file(join(dir, UNFINISHED_FILE)).exists()).toBe(false);
  });
});

describe('unit · x upgrade, one hop at a time and a hop that is stopped', () => {
  test('a second x upgrade in the same app is refused while the first holds the lock', async () => {
    const dir = await fixture();
    mkdirSync(join(dir, '.x'), { recursive: true });
    // The parent of this test process: alive for as long as the test runs.
    await Bun.write(
      join(dir, UPGRADE_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, startedAt: 'now' }),
    );
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner, TO);
    expect(code).toBe(1);
    expect(spawned).toEqual([]);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_LOCKED');
    expect(output.findings?.[0]?.fix).toStartWith(`ps -p ${String(process.ppid)}`);
  });

  test('every child carries the hop`s tag, and the run leaves no lock and no listener', async () => {
    const dir = await fixture();
    const { runner: scripted } = recording();
    const tags = new Set<string | undefined>();
    const runner: Runner = (command, options) => {
      tags.add(options.env?.[STEP_TAG_ENV]);
      return scripted(command, options);
    };
    const listening = process.listeners('SIGTERM').length;
    const { code } = await run(dir, runner, TO);
    expect(code).toBe(0);
    expect([...tags]).toEqual([`x-upgrade-${String(process.pid)}`]);
    expect(process.listeners('SIGTERM').length).toBe(listening);
    expect(await Bun.file(join(dir, UPGRADE_LOCK_FILE)).exists()).toBe(false);
  });
});
