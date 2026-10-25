// The shape of `.github/workflows/registry-audit.yml` that keeps its daily alarm loud and single:
// the issue step provisions its own `registry-drift` label BEFORE its first `gh issue` call,
// reads a failed create as already-exists only when `gh label view` confirms, and dies loudly
// otherwise. Reads the REAL workflow — each assertion is one a quiet edit to it would break with
// nothing red.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ROW_COMMANDS } from './health';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const REGISTRY_AUDIT_WORKFLOW = '.github/workflows/registry-audit.yml';

// Reads the real workflow, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly 'continue-on-error'?: boolean;
}

interface Job {
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on?: {
    readonly schedule?: readonly { readonly cron?: string }[];
    readonly workflow_dispatch?: unknown;
  };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

// The health table's `automation-alarms` row reads what this workflow files, so the label is read
// out of `ROW_COMMANDS` — the workflow and the row must answer from one label, never two.
const alarmsCommand = ROW_COMMANDS['automation-alarms'];
const label = /--label\s+(\S+)/.exec(alarmsCommand)?.[1] ?? '';

const text = await Bun.file(`${repoRoot()}/${REGISTRY_AUDIT_WORKFLOW}`).text();
const workflow = Bun.YAML.parse(text) as Workflow;
const steps = workflow.jobs?.['audit']?.steps ?? [];
// The step whose run touches issues — found by content, so a rename stays quiet.
const issue = steps.find((step) => step.run?.includes('gh issue'));
/** The step's shell without its comment lines: ordering is asked of the code, never the prose. */
const shell = (issue?.run ?? '')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
/** Where in `shell` the first occurrence of `needle` is, -1 when absent. */
const at = (needle: string): number => shell.indexOf(needle);

describe('unit · registry-audit.yml runs daily and holds the write its alarm needs', () => {
  test('one audit job, on a schedule and a manual dispatch and nothing else', () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['audit']);
    expect(Object.keys(workflow.on ?? {})).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on?.schedule?.[0]?.cron).toBe('17 6 * * *');
  });

  test('contents: read + issues: write at the top, no job-level override narrowing it', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' });
    // The label and the issue are written by steps of the audit job; a job-scoped permissions
    // block without `issues: write` would break both with nothing else red.
    expect(workflow.jobs?.['audit']?.permissions).toBeUndefined();
  });

  test('every --label the step writes is the one the health row reads', () => {
    expect(label).toBe('registry-drift');
    const written = [...shell.matchAll(/--label\s+(\S+)/g)].map((match) => match[1] ?? '');
    expect(written.length).toBeGreaterThan(0);
    for (const one of written) expect(one).toBe(label);
  });
});

describe('unit · the audit stays non-gating, and its failure is what files the issue', () => {
  test('exactly one continue-on-error step — the audit itself — that its outcome keys on', () => {
    const auditing = steps.filter((step) => step['continue-on-error'] === true);
    expect(auditing.length).toBe(1);
    expect(auditing[0]?.id).toBe('audit');
    expect(auditing[0]?.run).toContain('scripts/registry-audit.ts --json');
    expect(auditing[0]?.run).toContain('set -o pipefail');
  });

  test('the issue step runs only when the audit failed, and refuses loudly itself', () => {
    expect(issue).toBeDefined();
    expect(issue?.if).toBe("steps.audit.outcome == 'failure'");
    expect(issue?.['continue-on-error']).toBeUndefined();
  });

  test('the badge step fails the run on the same outcome', () => {
    const badge = steps.at(-1);
    expect(badge?.if).toBe("steps.audit.outcome == 'failure'");
    expect(badge?.run).toBe('exit 1');
  });
});

describe('unit · the issue step provisions the label before its first gh issue call', () => {
  test('create, then view, then the dedupe — the provisioning is the first gh command', () => {
    const create = at(`gh label create ${label}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(shell.slice(0, create)).not.toContain('gh ');
    expect(at('gh issue')).toBeGreaterThan(create);
    expect(create).toBeLessThan(at(`gh label view ${label}`));
    expect(at(`gh label view ${label}`)).toBeLessThan(at(`gh issue list --label ${label}`));
  });

  test('a failed create is already-exists only when a view confirms it', () => {
    expect(shell).toContain(
      `if ! err="$(gh label create ${label} --color d73a4a` +
        ` --description 'npm does not serve what this tree stamps' 2>&1)"; then`,
    );
    expect(shell).toContain(
      `gh label view ${label} >/dev/null 2>&1 || { printf '%s\\n' "$err" >&2; exit 1; }`,
    );
  });

  test('nothing on the provisioning path swallows a failure — no `|| true` in the step', () => {
    expect(shell).not.toContain('|| true');
  });
});

describe('unit · one open alarm at a time', () => {
  test('an open issue gets a comment; a create only when the open list came back empty', () => {
    expect(shell).toContain(`gh issue list --label ${label} --state open --limit 1`);
    expect(shell).toContain("--jq '.[0].number // empty'");
    expect(at('if [ -n "$existing" ]; then')).toBeGreaterThan(at(`gh issue list --label ${label}`));
    expect(at('gh issue comment "$existing"')).toBeGreaterThan(at('if [ -n "$existing" ]; then'));
    expect(at(`gh issue create --label ${label}`)).toBeGreaterThan(
      at('gh issue comment "$existing"'),
    );
  });
});
