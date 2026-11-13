// The caches ci.yml and the setup composite restore, held to what each entry holds: the install
// cache keyed on the packages bun.lock resolves (not on the workspace versions a release rewrites),
// and each tracked app's built islands kept between runs. Split from `ci-workflow-shape.test.ts`.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { ISLAND_CACHE_DIR } from '../packages/cli/src/island-group-cache';
import { expr, jobOf, readWorkflow, type Step, text } from './lib/ci-workflow-read';
import { repoRoot } from './lib/run';

const ci = await readWorkflow('ci.yml');
const composite = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/actions/setup/action.yml`).text(),
) as { readonly runs?: { readonly steps?: readonly Step[] } };
const lock = await Bun.file(`${repoRoot()}/bun.lock`).text();

describe('unit · ci.yml · each tracked app keeps its built islands between runs', () => {
  const steps = jobOf(ci, 'reference-app-verify').steps ?? [];
  const at = steps.findIndex(
    (step) =>
      text(step.uses).startsWith('actions/cache@') &&
      text(step.with?.['path']).endsWith(ISLAND_CACHE_DIR),
  );
  const cache = steps[at];

  test('the island cache is restored from the app`s own .x/cache, before its build', () => {
    expect(at).toBeGreaterThanOrEqual(0);
    expect(cache?.with?.['path']).toBe(`${expr('matrix.app')}/${ISLAND_CACHE_DIR}`);
    expect(
      steps.findIndex((step) => text(step.run).includes('reference-app-gate.ts')),
    ).toBeGreaterThan(at);
  });

  // Every entry re-hashes what it read before it is reused (`island-group-cache.ts`), so the key
  // only decides when a new entry is saved, and any older one is a warm start, never wrong bytes.
  test('keyed on bun.lock and the island sources, restored from the newest of the app`s', () => {
    const sources = "hashFiles(format('{0}/apps/**/*.tsx', matrix.app), 'packages/*/src/**/*.tsx')";
    const prefix = `islands-${expr('matrix.app')}-`;
    expect(cache?.with?.['key']).toBe(`${prefix}${expr("hashFiles('bun.lock')")}-${expr(sources)}`);
    expect(cache?.with?.['restore-keys']).toBe(prefix);
    // An app with no island has nothing to keep; the step is skipped, never an empty save.
    expect(cache?.if).toBe("hashFiles(format('{0}/apps/**/*.island.tsx', matrix.app)) != ''");
  });
});

describe('unit · setup composite · the install cache is keyed on what it holds', () => {
  const steps = composite.runs?.steps ?? [];
  const digests = steps.filter((step) => text(step.id).startsWith('lock_'));
  const cache = steps.findIndex((step) => text(step.uses).startsWith('actions/cache@'));
  // The digest step of THIS runner's OS, RUN as CI runs it over every lock below, each in a
  // scratch dir holding only its `bun.lock`: bash off Windows, pwsh on it (ci.yml's `windows` job
  // lists this file). pwsh is never started off Windows: a cold start on ubuntu-latest under
  // coverage outlived 10 s (run 43450645963), and its kill read as `lock_windows must exit 0`.
  // ONE process runs the step in every dir, so a start is paid once per run, not per lock.
  const drivers = {
    // A subshell per dir, so the step's `set -euo pipefail` and `cd` stay in it; `$?` is read
    // apart from the subshell because `( … ) || exit` would switch its `-e` off.
    bash: [
      'bash',
      '-c',
      'while IFS= read -r d; do (cd "$d" && export GITHUB_OUTPUT="$d/output" && eval "$STEP"); s=$?; [ "$s" -eq 0 ] || exit "$s"; done <<< "$DIRS"',
    ],
    // `$ErrorActionPreference = 'stop'` is the line Actions prepends to every pwsh step.
    pwsh: [
      'pwsh',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'stop'; $step = [scriptblock]::Create($env:STEP); foreach ($d in $env:DIRS -split \"`n\") { Set-Location -LiteralPath $d; $env:GITHUB_OUTPUT = Join-Path $d 'output'; & $step }",
    ],
  } as const;
  const own = process.platform === 'win32' ? 'pwsh' : 'bash';
  const step = digests.find((candidate) => text(candidate.shell) === own);
  /** Every lock's digest line as `step` writes it, from one process. */
  const digestsOf = async (locks: readonly string[]): Promise<readonly string[]> => {
    const root = await mkdtemp(join(tmpdir(), 'lock-digest-'));
    try {
      const dirs = locks.map((_, index) => join(root, String(index)));
      await Promise.all(
        locks.map((lock, index) => Bun.write(join(root, String(index), 'bun.lock'), lock)),
      );
      const env = {
        ...Bun.env,
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        STEP: text(step?.run),
        DIRS: dirs.join('\n'),
      };
      const proc = Bun.spawn([...drivers[own]], { cwd: root, env, stderr: 'pipe' });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, `${text(step?.id)} must exit 0: ${stderr}`).toBe(0);
      // Awaited here, not returned: `finally` would remove the dirs before the reads.
      return await Promise.all(
        dirs.map(async (dir) => (await Bun.file(join(dir, 'output')).text()).trim()),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const at = lock.indexOf('\n  "packages": {');
  const head = lock.slice(0, at);
  const bumped = head.replace(/"version": "[^"]+"/, '"version": "999.0.0"');
  // The cross-shell guarantee, with only one shell per OS: each holds these fixed locks to the
  // SAME committed hex, so the bash step (Linux, macOS) and the pwsh step (Windows) hash the same
  // bytes. A lock with a `"packages"` line hashes from that line; one without, the whole file.
  const FIXTURE =
    '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": { "name": "fixture", "version": "1.0.0" },\n  },\n  "packages": {\n    "a": ["a@1.0.0", "", {}, "sha512-AAAA"],\n  }\n}\n';
  const FIXTURE_DIGEST = 'digest=59e95b20a5b7c315a0354a742fe4b149b51b9fd17a46dbfe5c9bd3d042264a87';
  const BARE = '{\n  "lockfileVersion": 9,\n}\n';
  const BARE_DIGEST = 'digest=0e3db0e964aa678d76b1c155cf89cce081dce9248c4f3c594432da373b562853';
  const variants = new Map([
    ['lock', lock],
    ['bumped', bumped + lock.slice(at)],
    ['moved', lock.replace(/("sha512-)[A-Za-z0-9]/, '$1_')],
    ['fixture', FIXTURE],
    ['bare', BARE],
  ]);
  // Both tests read one run, started by whichever asks first.
  let ran: Promise<ReadonlyMap<string, string>> | undefined;
  const digestsFor = (): Promise<ReadonlyMap<string, string>> => {
    ran ??= digestsOf([...variants.values()]).then(
      (lines) => new Map([...variants.keys()].map((name, index) => [name, lines[index] ?? ''])),
    );
    return ran;
  };
  const sha = (bytes: string): string =>
    `digest=${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

  test('one digest per shell, before the restore that keys on it, and never `bun`', () => {
    expect(digests.map((step) => [step.id, step.shell, step.if])).toEqual([
      ['lock_posix', 'bash', "runner.os != 'Windows'"],
      ['lock_windows', 'pwsh', "runner.os == 'Windows'"],
    ]);
    // `bun` reads the checkout's bunfig.toml, so it would run repo code with the cache token
    // before the save: CodeQL's actions/cache-poisoning/poisonable-step.
    for (const step of digests) expect(text(step.run)).not.toMatch(/\bbun\s/);
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(digests[1] ?? {})).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(digests[1] ?? {})).toBeLessThan(cache);
    // One cache: a second restore beside it is a second entry, keyed on something else.
    expect(steps.filter((step) => text(step.uses).startsWith('actions/cache@'))).toHaveLength(1);
    const options = steps[cache]?.with ?? {};
    expect(options['key']).toBe(
      `bun-${expr('runner.os')}-${expr('steps.lock_posix.outputs.digest')}${expr('steps.lock_windows.outputs.digest')}`,
    );
    // A prefix fallback saves the old lock's packages beside the new: the entry only grows.
    expect(Object.keys(options).sort()).toEqual(['key', 'path']);
  });

  // A release rewrites every workspace's version in bun.lock and no package the cache holds, so
  // a release commit restores the same entry instead of cold-installing in every job.
  test('the digest moves with the resolved packages, never with a workspace version', async () => {
    // The bytes both shells hash: the `"packages"` line to the end.
    const expected = sha(lock.slice(at + 1));
    expect(at).toBeGreaterThan(0);
    expect(bumped).not.toBe(head);
    expect(text(step?.shell)).toBe(own);
    const got = await digestsFor();
    expect(got.get('lock'), text(step?.id)).toBe(expected);
    expect(got.get('bumped'), text(step?.id)).toBe(expected);
    expect(got.get('moved'), text(step?.id)).not.toBe(expected);
  });

  test('both shells hash a fixed lock to one committed digest, and a bare one whole', async () => {
    // The committed hex is the rule's, not a recording: Bun's own hash of the same slice.
    expect(sha(FIXTURE.slice(FIXTURE.indexOf('\n  "packages": {') + 1))).toBe(FIXTURE_DIGEST);
    expect(sha(BARE)).toBe(BARE_DIGEST);
    const got = await digestsFor();
    expect(got.get('fixture'), text(step?.id)).toBe(FIXTURE_DIGEST);
    expect(got.get('bare'), text(step?.id)).toBe(BARE_DIGEST);
  });
});
