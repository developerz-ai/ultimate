// `scripts/tag-on-origin.ts` ships with five reachable answers: a refused missing positional, a
// refused non-version string, `ok:true` with `onOrigin:true` and `onOrigin:false`, and `ok:false`
// when git could not answer (`X_REGISTRY_UNREACHABLE`). Without this file every branch was
// reachable only from the script's own `import.meta.main` body, and any branch deleted there
// would stay green in the tree — so a denial that lost its finding or a probe path that lost
// its `ok:false` would pass CI.
//
// The two refusals are reached through the real CLI surface (`bun run scripts/tag-on-origin.ts`)
// because the entry point bails before `tagOnOrigin` is called and that is the surface PUBLISHING
// names. The three probe-driven branches drive the exported function with a stub probe, the same
// seam `release-due.test.ts` uses for `lastReleaseTag`'s remote answer.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { tagOnOrigin } from './tag-on-origin';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/**
 * Drive the real entry point under `--json`, so the whole reply is one parseable envelope. A
 * non-`--json` run renders a `✗ <summary>` line beside the three-line finding, and the LAST
 * line is then the finding's code — JSON.parse would read prose as a syntax error rather
 * than a missing contract.
 *
 * `--json` is last because `parseScriptArgs` swallows whatever follows it as the flag's value
 * (`--json v1.0.0` becomes `--json=v1.0.0`, exactly the trap the parser refutes). That would be
 * a test-only artifact rather than the input the script under test sees.
 */
const ran = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(['bun', 'run', 'scripts/tag-on-origin.ts', ...argv, '--json'], {
    cwd: repoRoot(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
};

const findingFor = (out: string): { code: string; fix: string } => {
  const document = JSON.parse(out.trim()) as {
    findings?: readonly { code: string; fix: string }[];
  };
  const finding = document.findings?.[0];
  expect(finding, `no finding in CLI output: ${out}`).toBeDefined();
  return finding as { code: string; fix: string };
};

describe('unit · tag-on-origin · refusals from the real entry point', () => {
  test('no positional: refused with X_CLI_BAD_FLAG and the runnable fix', async () => {
    const { code, out } = await ran([]);
    expect(code).toBe(1);
    // `toMatchObject` rather than `toEqual`: the finding carries `cause` and `at` that the test
    // does not need to pin, and over-pinning on prose would tie the gate to wording rather than
    // to the contract a refusal is for. A regression that dropped the `code` or the `fix` field
    // fails; a regression that reworded the cause does not.
    expect(findingFor(out)).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'bun run scripts/tag-on-origin.ts 26.1.1 --json',
    });
  });

  test('a version carrying a leading v is refused as not the form this repo stamps', async () => {
    // `v1.0.0` looks like a version to a person; the script would then prefix it again to `vv1.0.0`,
    // a tag nothing on origin holds. Refused on the shape rather than probed with a wrong tag.
    const { code, out } = await ran(['v1.0.0']);
    expect(code).toBe(1);
    const finding = findingFor(out);
    expect(finding.code).toBe('X_CLI_BAD_FLAG');
    expect(out).toContain('not a version');
  });
});

describe('unit · tag-on-origin · the probe-driven branches', () => {
  test('origin holds the tag: ok:true, onOrigin:true, and the tag is what the probe was asked', async () => {
    // The probe receives the `v`-prefixed form: the shell that decides the answer reads tags, and
    // a probe handed the raw version would race with every `v`-aware consumer in the tree.
    const asked: string[] = [];
    const answer = await tagOnOrigin('1.0.0', async (tag) => {
      asked.push(tag);
      return true;
    });
    expect(asked).toEqual(['v1.0.0']);
    expect(answer.ok).toBe(true);
    expect(answer.data).toEqual({ tag: 'v1.0.0', onOrigin: true });
    expect(answer.summary).toContain('on origin');
  });

  test('origin rejects the tag: ok:true, onOrigin:false — a local-only tag, not an error', async () => {
    // The probe's `false` is "git answered no", which is different from "git could not answer".
    // Folding both into one would re-introduce the bug the script exists to fix: a `behind`
    // package whose tag was never pushed would dispatch the workflow at a missing ref.
    const answer = await tagOnOrigin('1.0.0', async () => false);
    expect(answer.ok).toBe(true);
    expect(answer.data).toEqual({ tag: 'v1.0.0', onOrigin: false });
    expect(answer.summary).toContain('not on origin');
    // A denial carries no finding — the whole point of separating the two answers.
    expect(answer.findings).toBeUndefined();
  });

  test('git could not answer: ok:false with X_REGISTRY_UNREACHABLE and onOrigin:null', async () => {
    // `undefined` from the probe is git's no-answer, never a denial. Returning `ok:false` here is
    // what stops callers from reading "absent" as "not yet pushed": the two are different facts
    // about a release, and only one lets them dispatch the workflow.
    const answer = await tagOnOrigin('1.0.0', async () => undefined);
    expect(answer.ok).toBe(false);
    expect(answer.data).toEqual({ tag: 'v1.0.0', onOrigin: null });
    const finding = answer.findings?.[0];
    expect(finding, 'unreachable probe must carry a finding').toBeDefined();
    expect(finding?.code).toBe('X_REGISTRY_UNREACHABLE');
    // The fix must be pasteable, and it must ENUMERATE the verification — a reader who only
    // re-runs the script cannot distinguish a denial from a network failure.
    expect(finding?.fix).toContain('git ls-remote --exit-code --tags origin refs/tags/v1.0.0');
    expect(finding?.fix).toContain('bun run scripts/tag-on-origin.ts <version> --json');
  });
});
