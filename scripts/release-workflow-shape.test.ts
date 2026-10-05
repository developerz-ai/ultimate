// The shape of `.github/workflows/release.yml` that makes a publish refusable for free and
// resumable after a partial failure. Reads the REAL workflow — the release runs from that file, and
// each assertion is one a revert of it would otherwise make silently.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { RELEASE_WORKFLOW } from './release-workflow';

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
}

interface Job {
  readonly needs?: string | readonly string[];
  readonly environment?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: boolean };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

// A backstop, not an assertion: under the gate's full run every scripts test shares the machine,
// and the whole-repo readers here run on `REPO_SCAN_TIMEOUT_MS` like their siblings.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const text = await Bun.file(`${repoRoot()}/${RELEASE_WORKFLOW}`).text();
// A cast over a parse, never `any`: every read below tolerates an absent key, and a workflow that
// does not parse at all throws here, which is the loudest failure this file can give.
const workflow = Bun.YAML.parse(text) as Workflow;
const job = (name: string): Job => workflow.jobs?.[name] ?? {};
const runs = (name: string): string =>
  (job(name).steps ?? []).map((step) => step.run ?? '').join('\n');

describe('unit · release.yml refuses before anyone is asked to approve', () => {
  // A Release cut before the bump — developerz-ai[bot] makes those — failed `--check` only AFTER the
  // `npm-publish` deployment had been requested (runs 35827049144, 35789073198).
  test('the check job carries no environment, and runs --check and the ref refusal', () => {
    expect(job('check').environment).toBeUndefined();
    expect(runs('check')).toContain('scripts/release.ts --check');
    expect(runs('check')).toContain('refs/tags/v*');
  });

  test('publish needs check and is the one job behind npm-publish', () => {
    const needs = job('publish').needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain('check');
    expect(JSON.stringify(job('publish').environment)).toContain('npm-publish');
  });

  test('id-token: write is held by the publish job alone', () => {
    expect(workflow.permissions?.['id-token']).toBeUndefined();
    expect(job('check').permissions?.['id-token']).toBeUndefined();
    expect(job('publish').permissions?.['id-token']).toBe('write');
  });
});

describe('unit · release.yml reads the gate rather than re-running it', () => {
  // The re-run had no Postgres, NATS or Redis: the 21.0.0 run ran 10 of 342 live tests.
  test('no job re-runs verify', () => {
    const every = Object.keys(workflow.jobs ?? {})
      .map(runs)
      .join('\n');
    expect(every).toContain('npm publish');
    expect(every).not.toMatch(/scripts\/verify\.ts|\bx verify\b|run verify\b/);
  });

  // The RUN's conclusion, never one job's: `verify` is the framework gate alone, and a tag whose
  // tracked apps, scaffolds or container build were red on the same run published anyway.
  test('the check job requires the whole ci.yml run to have passed on the tagged commit', () => {
    expect(runs('check')).toContain('actions/workflows/ci.yml/runs?head_sha=');
    expect(runs('check')).toContain('&event=push&per_page=1');
    expect(runs('check')).toContain('\\(.status // "") \\(.conclusion // "")');
    // A run still going has no conclusion yet, and is no verdict.
    expect(runs('check')).toContain('[ "$status" = completed ] || conclusion=""');
    expect(runs('check')).not.toContain('/jobs?');
  });
});

describe('unit · release.yml is resumable and pinned', () => {
  test('a package already on npm at this version is skipped, not re-published into E403', () => {
    expect(runs('publish')).toContain('npm view');
    expect(runs('publish')).toContain('npm publish');
  });

  const usesOf = (name: string): readonly string[] =>
    (job(name).steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
  const SHA_PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

  // The job holding `id-token: write` takes no action by a tag a third party can move, and no
  // local composite — whose cache a previous run wrote. Every workflow's pins: workflow-pins.test.ts.
  test('every action in the publish job is pinned by commit SHA', () => {
    expect(usesOf('publish').length).toBeGreaterThan(0);
    for (const ref of usesOf('publish')) expect(ref).toMatch(SHA_PINNED);
  });

  test('every other action is SHA-pinned or the repo composite', () => {
    for (const name of Object.keys(workflow.jobs ?? {})) {
      for (const ref of usesOf(name)) {
        expect(ref === './.github/actions/setup' || SHA_PINNED.test(ref)).toBe(true);
      }
    }
  });

  // `--follow-tags` skips a lightweight tag, so a printed `git tag vX` is a tag that never lands.
  test('every tag command it prints is annotated', () => {
    const tags = [...text.matchAll(/git tag\s+(\S+)/g)].map((match) => match[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const flag of tags) expect(flag).toBe('-a');
  });
});

describe('unit · release.yml queues releases and never cancels one', () => {
  // A per-ref group (`release-${{ github.ref }}`) serialized nothing across versions: two Releases
  // cut minutes apart published side by side, and `latest` went to whichever finished last per
  // package — a lockstep set split across two versions. One fixed group is one queue.
  test('one fixed group for every release, and cancel-in-progress is false', () => {
    expect(workflow.concurrency?.group).toBe('release');
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });
});
