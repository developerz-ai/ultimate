// The shape of `.github/workflows/security-channel.yml` that keeps its daily alarms honest. `check`:
// only a literal `true` passes, the label is provisioned before any `gh issue` call, `issues: write`
// is its only permission, and nothing is checked out. `floors`: the advisory script's red survives
// `tee`, the lockfile follows the raised manifests, and the job can propose but never publish. Each
// rule is a pure check over the workflow's text, run on the REAL file and on a mutated copy.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const WORKFLOW = '.github/workflows/security-channel.yml';
const LABEL = 'security-channel';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<
    Record<string, { readonly permissions?: unknown; readonly steps?: readonly Step[] }>
  >;
}

/** Shell lines without comments: ordering is asked of the code, never the prose. */
const shellOf = (steps: readonly Step[]): string =>
  steps
    .map((step) => step.run ?? '')
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const FLOORS_PERMISSIONS = { contents: 'write', 'pull-requests': 'write', issues: 'write' };

/** Every rule the workflow breaks, by name; empty is the shape held. */
function shapeGaps(text: string): readonly string[] {
  const workflow = Bun.YAML.parse(text) as Workflow;
  const gaps: string[] = [];
  const check = workflow.jobs?.['check'];
  const steps = check?.steps ?? [];
  const shell = shellOf(steps);
  const at = (needle: string): number => shell.indexOf(needle);

  // Each job holds its own: a workflow-wide grant would hand `check` the `floors` job's writes.
  if (JSON.stringify(workflow.permissions) !== '{}') gaps.push('permissions');
  if (JSON.stringify(check?.permissions) !== JSON.stringify({ issues: 'write' })) {
    gaps.push('job-permissions');
  }
  if (steps.some((step) => step.uses !== undefined)) gaps.push('checkout');
  if (!Object.keys(workflow.on ?? {}).includes('schedule')) gaps.push('schedule');

  // The only pass is the literal string `true`: `false`, an error text or an empty read all alarm.
  const passes = [...shell.matchAll(/if \[ (.+?) \]; then\s*\n\s*echo [^\n]*\n\s*exit 0/g)];
  if (passes.length !== 1 || passes[0]?.[1] !== '"$enabled" = "true"') gaps.push('literal-true');
  if (!shell.includes("private-vulnerability-reporting\" --jq '.enabled'")) gaps.push('read');

  const create = at(`gh label create ${LABEL}`);
  const issue = at('gh issue');
  if (create === -1 || issue === -1 || create > issue) gaps.push('label-first');
  if (!shell.includes(`gh api "repos/\${GITHUB_REPOSITORY}/labels/${LABEL}" >/dev/null 2>&1 ||`)) {
    gaps.push('label-confirm');
  }
  // The alarm path ends red, so the run's badge says what the issue says.
  if (!/gh issue create[^\n]*\n\s*fi\s*\n\s*exit 1\s*$/.test(shell.trimEnd()))
    gaps.push('exit-red');
  return [...gaps, ...floorsGaps(workflow)];
}

/** The advisory job's rules: it proposes a raise and alarms on the rest, and it never publishes. */
function floorsGaps(workflow: Workflow): readonly string[] {
  const floors = workflow.jobs?.['floors'];
  const steps = floors?.steps ?? [];
  const shell = shellOf(steps);
  const gaps: string[] = [];
  if (JSON.stringify(floors?.permissions) !== JSON.stringify(FLOORS_PERMISSIONS)) {
    gaps.push('floors-permissions');
  }
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@') === true);
  if (checkout?.with?.['persist-credentials'] !== false) gaps.push('floors-credentials');
  if (
    !/set -o pipefail\s*\n\s*bun run scripts\/advisory-floors\.ts --write --json \| tee/.test(shell)
  ) {
    gaps.push('floors-pipefail');
  }
  const install = shell.indexOf('bun install --lockfile-only --ignore-scripts');
  const add = shell.indexOf('git add');
  if (install === -1 || add === -1 || install > add || !/git add [^\n]*bun\.lock/.test(shell)) {
    gaps.push('floors-lockfile');
  }
  // A re-resolved dependency's install script must never see the write token: the step that
  // installs holds no env at all, and the step that holds the token never installs.
  const installs = steps.filter((step) => /\bbun (?:install|i|add)\b/.test(step.run ?? ''));
  if (installs.some((step) => step.env !== undefined)) gaps.push('floors-install-token');
  const pushes = steps.filter((step) => /git push|gh pr /.test(step.run ?? ''));
  if (pushes.length === 0 || pushes.some((step) => /\bbun\b/.test(step.run ?? ''))) {
    gaps.push('floors-push-runs-bun');
  }
  if (/npm publish|bun publish/.test(shell)) gaps.push('floors-publish');
  const label = shell.indexOf('gh label create security-advisory');
  const issue = shell.indexOf('gh issue');
  if (label === -1 || issue === -1 || label > issue) gaps.push('floors-label-first');
  if (steps.at(-1)?.run?.trim() !== 'exit 1') gaps.push('floors-exit-red');
  return gaps;
}

const real = await Bun.file(`${repoRoot()}/${WORKFLOW}`).text();

describe('security-channel.yml holds its shape', () => {
  test('the real workflow breaks no rule', () => {
    expect(shapeGaps(real)).toEqual([]);
  });
});

describe('a mutated copy goes red on the rule it breaks', () => {
  const mutate = (from: string, to: string): string => {
    expect(real).toContain(from);
    return real.replace(from, to);
  };

  test('a truthy test instead of the literal `true`', () => {
    expect(shapeGaps(mutate('[ "$enabled" = "true" ]', '[ -n "$enabled" ]'))).toContain(
      'literal-true',
    );
  });

  test('a comparison that also passes on `false`', () => {
    expect(shapeGaps(mutate('[ "$enabled" = "true" ]', '[ "$enabled" != "" ]'))).toContain(
      'literal-true',
    );
  });

  test('a second permission on the channel check', () => {
    expect(
      shapeGaps(mutate('      issues: write\n', '      issues: write\n      contents: write\n')),
    ).toContain('job-permissions');
  });

  test('a workflow-wide grant', () => {
    expect(shapeGaps(mutate('permissions: {}\n', 'permissions:\n  issues: write\n'))).toContain(
      'permissions',
    );
  });

  test('a checkout step', () => {
    const withCheckout = mutate(
      '    timeout-minutes: 5\n    steps:\n',
      '    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
    );
    expect(shapeGaps(withCheckout)).toContain('checkout');
  });

  test('the issue lookup moved above the label creation', () => {
    const list =
      '          existing="$(gh issue list --label security-channel --state open --limit 1 --json number --jq \'.[0].number // empty\')"\n';
    const moved = mutate(list, '').replace(
      '          if ! err="$(gh label create',
      `${list}          if ! err="$(gh label create`,
    );
    expect(shapeGaps(moved)).toContain('label-first');
  });

  test('the alarm path no longer fails the run', () => {
    const quiet = mutate(
      '            gh issue create --label security-channel --title "security: the private vulnerability channel is closed" --body "$body"\n          fi\n          exit 1\n',
      '            gh issue create --label security-channel --title "security: the private vulnerability channel is closed" --body "$body"\n          fi\n          exit 0\n',
    );
    expect(shapeGaps(quiet)).toContain('exit-red');
  });

  test('the advisory job gains the publish token', () => {
    expect(
      shapeGaps(
        mutate(
          '      issues: write\n    runs-on: ubuntu-latest\n    # One packument',
          '      issues: write\n      id-token: write\n    runs-on: ubuntu-latest\n    # One packument',
        ),
      ),
    ).toContain('floors-permissions');
  });

  test('the advisory checkout keeps the token in .git/config', () => {
    const persisted = real.replace(
      /persist-credentials: false\n(?![\s\S]*persist-credentials)/,
      'persist-credentials: true\n',
    );
    expect(persisted).not.toBe(real);
    expect(shapeGaps(persisted)).toContain('floors-credentials');
  });

  test('the advisory step loses pipefail, so tee decides its exit', () => {
    expect(
      shapeGaps(
        mutate(
          '          set -o pipefail\n          bun run scripts/advisory-floors.ts',
          '          bun run scripts/advisory-floors.ts',
        ),
      ),
    ).toContain('floors-pipefail');
  });

  test('the raised manifests are committed without the lockfile', () => {
    expect(
      shapeGaps(
        mutate('git add packages/*/package.json bun.lock', 'git add packages/*/package.json'),
      ),
    ).toContain('floors-lockfile');
  });

  test('the install that re-resolves the raised ranges carries the write token', () => {
    const install = '          bun install --lockfile-only --ignore-scripts\n';
    const step = real.slice(0, real.indexOf(install));
    const head = step.lastIndexOf('      - name:');
    const named = real.slice(head, real.indexOf('\n', head) + 1);
    const tokened = real.replace(
      named,
      `${named}        env:\n          GH_TOKEN: \${{ github.token }}\n`,
    );
    expect(tokened).not.toBe(real);
    expect(shapeGaps(tokened)).toContain('floors-install-token');
  });

  test('install scripts run: the lockfile refresh drops --ignore-scripts', () => {
    expect(
      shapeGaps(mutate('bun install --lockfile-only --ignore-scripts', 'bun install')),
    ).toContain('floors-lockfile');
  });

  test('the step holding the token installs again', () => {
    expect(
      shapeGaps(
        mutate(
          "          BRANCH='security/advisory-floors'\n          # One branch",
          "          BRANCH='security/advisory-floors'\n          bun install\n          # One branch",
        ),
      ),
    ).toContain('floors-push-runs-bun');
  });

  test('the advisory job publishes', () => {
    expect(
      shapeGaps(mutate('          git push', '          npm publish -ws\n          git push')),
    ).toContain('floors-publish');
  });

  test('the advisory run no longer ends red', () => {
    expect(shapeGaps(real.replace(/run: exit 1\s*$/, 'run: exit 0\n'))).toContain(
      'floors-exit-red',
    );
  });
});
