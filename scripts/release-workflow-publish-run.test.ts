// `.github/workflows/release.yml`'s publish step, RUN: its real `run:` script under bash with `bun`,
// `npm` and `sleep` stubbed on PATH. The weekly bot release has no human on call, so a transient
// publish failure (a Sigstore TLOG 409, an E401 on a slow token exchange, a registry 5xx) is retried
// a bounded number of times, and npm is asked again before every retry: an attempt that failed
// AFTER the registry took the tarball is never re-published into E403. The shape test holds the text.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod } from 'node:fs/promises'; // why: Bun has no chmod.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { tempTrees } from '../packages/testing/src/temp-tree';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { RELEASE_WORKFLOW } from './release-workflow';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const trees = tempTrees();
afterAll(() => trees.dispose());

interface Step {
  readonly name?: string;
  readonly run?: string;
}
const workflow = Bun.YAML.parse(await Bun.file(join(repoRoot(), RELEASE_WORKFLOW)).text()) as {
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
};
const script =
  workflow.jobs?.['publish']?.steps?.find((step) => step.run?.includes('npm publish'))?.run ?? '';

const PLAN = JSON.stringify({
  data: [
    { name: '@x/a', tier: 0, publish: 'public' },
    { name: '@x/b', tier: 1, publish: 'public' },
  ],
});

/**
 * `npm view` answers the version once `$STATE/<name>` exists. `npm publish` of `@x/a` fails its
 * first `$FAIL_A` attempts — writing the state file anyway when `$LANDS` is 1, the attempt that
 * died after the registry took the tarball — and every other publish succeeds.
 */
const NPM = `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
key="$(printf '%s' "$2" | tr '@/' '__')"
if [ "$1" = view ]; then
  name="\${2%@*}"; key="$(printf '%s' "$name" | tr '@/' '__')"
  if [ -f "$STATE/$key" ]; then echo "$VERSION"; exit 0; fi
  echo 'npm error code E404' >&2; exit 1
fi
if [ "$1" = publish ]; then
  key="$(printf '%s' "$3" | tr '@/' '__')"
  tries=$(( $(cat "$STATE/$key.tries" 2>/dev/null || echo 0) + 1 )); echo "$tries" > "$STATE/$key.tries"
  if [ "$3" = '@x/a' ] && [ "$tries" -le "$FAIL_A" ]; then
    if [ "$LANDS" = 1 ]; then touch "$STATE/$key"; fi
    echo 'npm error code E409 TLOG_CREATE_ENTRY_ERROR (409) an equivalent entry already exists'; exit 1
  fi
  touch "$STATE/$key"; echo "+ $3@$VERSION"; exit 0
fi
`;

async function publish(failA: number, lands: boolean) {
  const dir = await trees.make('release-publish-');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  await Bun.write(join(state, '.keep'), '');
  const stubs: Record<string, string> = {
    bun: `#!/usr/bin/env bash\necho '${PLAN}'\n`,
    npm: NPM,
    sleep: '#!/usr/bin/env bash\necho "$1" >> "$SLEEPS"\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    await Bun.write(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  const env = {
    PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
    CALLS: join(dir, 'calls'),
    SLEEPS: join(dir, 'sleeps'),
    STATE: state,
    FAIL_A: String(failA),
    LANDS: lands ? '1' : '0',
    VERSION: '9.9.9',
    DIST_TAG: 'latest',
  };
  await Bun.write(join(dir, 'step.sh'), script);
  const out = await run(['bash', join(dir, 'step.sh')], { cwd: dir, env });
  const lines = async (file: string) =>
    (await Bun.file(file).exists())
      ? (await Bun.file(file).text()).split('\n').filter(Boolean)
      : [];
  const calls = (await lines(env.CALLS)).map((call) => call.replace(/ --tag latest$/, ''));
  return { ok: out.ok, output: out.output, calls, sleeps: await lines(env.SLEEPS) };
}

describe('unit · release.yml · the publish step, run', () => {
  test('the script under test is the real publish step', () => {
    expect(script).toContain('npm publish -w "$name" --tag "$DIST_TAG"');
  });

  test('a transient failure is retried after a pause, npm asked again first, and the run is green', async () => {
    const got = await publish(1, false);
    expect({ ok: got.ok, output: got.output }).toMatchObject({ ok: true });
    expect(got.calls).toEqual([
      'view @x/a@9.9.9 version',
      'publish -w @x/a',
      'view @x/a@9.9.9 version',
      'publish -w @x/a',
      'view @x/b@9.9.9 version',
      'publish -w @x/b',
    ]);
    expect(got.sleeps).toHaveLength(1);
  });

  test('a failed attempt the registry took anyway is found by npm view and never re-published', async () => {
    const got = await publish(1, true);
    expect({ ok: got.ok, output: got.output }).toMatchObject({ ok: true });
    expect(got.calls).toEqual([
      'view @x/a@9.9.9 version',
      'publish -w @x/a',
      'view @x/a@9.9.9 version',
      'view @x/b@9.9.9 version',
      'publish -w @x/b',
    ]);
  });

  test('bounded: three attempts, then the run is red and publishes nothing after it', async () => {
    const got = await publish(99, false);
    expect(got.ok).toBe(false);
    expect(got.calls.filter((call) => call === 'publish -w @x/a')).toHaveLength(3);
    expect(got.calls.filter((call) => call.includes('@x/b'))).toEqual([]);
    expect(got.sleeps).toHaveLength(2);
    expect(got.output).toContain('::error::');
    expect(got.output).toContain('gh workflow run release.yml');
  });
});
