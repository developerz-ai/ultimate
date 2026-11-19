// Every workflow that pushes a branch of THIS repository with the job token dispatches ci.yml on
// that branch. A push made with GITHUB_TOKEN starts no workflow, so the pull request it opens never
// gets a `verify` check and waits behind branch protection forever — security-channel.yml's
// advisory floors and bench.yml's figures did, unattended. `gh workflow run` is GitHub's exception.
// Reads every REAL workflow, and a mutated copy proves each rule can go red.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Glob } from 'bun';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly run?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}
interface Job {
  readonly permissions?: unknown;
  readonly steps?: readonly Step[];
}
interface Shape {
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, Job>>;
}

/** `git push … "https://x-access-token:${VAR}@github.com/${GITHUB_REPOSITORY}.git" <ref>`. */
const TOKEN_PUSH =
  /git push\b[^\n]*x-access-token:\$\{(\w+)\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"?\s+(\S+)/g;
const JOB_TOKEN = /^\$\{\{\s*github\.token\s*\}\}$/;

/** `HEAD:refs/heads/next` -> `next`; `"$BRANCH"` stays as the shell spells it. */
const branchOf = (ref: string): string => ref.replace(/^[^:]*:/, '').replace(/^refs\/heads\//, '');

const grants = (permissions: unknown): Readonly<Record<string, unknown>> =>
  typeof permissions === 'object' && permissions !== null
    ? (permissions as Record<string, unknown>)
    : {};

/** Each push of a branch with the job token that no ci.yml dispatch follows, by `file:job`. */
function undispatchedPushes(file: string, text: string): readonly string[] {
  const workflow = Bun.YAML.parse(text) as Shape;
  const gaps: string[] = [];
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const run = (step.run ?? '')
        .split('\n')
        .filter((line) => !/^\s*(?:#|echo )/.test(line))
        .join('\n');
      for (const push of run.matchAll(TOKEN_PUSH)) {
        const token = String(step.env?.[push[1] as string] ?? '');
        // A personal token's push starts ci.yml itself (next-sync.yml's NEXT_SYNC_TOKEN).
        if (!JOB_TOKEN.test(token)) continue;
        if (/^refs\/tags\//.test(push[2] as string)) continue;
        const branch = branchOf(push[2] as string);
        const after = run.slice((push.index ?? 0) + push[0].length);
        if (!after.includes(`gh workflow run ci.yml --ref ${branch}`)) {
          gaps.push(`${file}:${name} pushes ${branch} and dispatches no ci.yml there`);
        }
        const actions =
          grants(job.permissions)['actions'] ?? grants(workflow.permissions)['actions'];
        if (actions !== 'write') gaps.push(`${file}:${name} dispatches without actions: write`);
      }
    }
  }
  return gaps;
}

const dir = `${repoRoot()}/.github/workflows`;
const files = [...new Glob('*.yml').scanSync(dir)].sort();
const texts = new Map(
  await Promise.all(files.map(async (f) => [f, await Bun.file(`${dir}/${f}`).text()] as const)),
);

describe('unit · a branch pushed with the job token is gated by a dispatched ci.yml', () => {
  test('every real workflow holds it', () => {
    expect(files.length).toBeGreaterThan(5);
    expect([...texts].flatMap(([file, text]) => undispatchedPushes(file, text))).toEqual([]);
  });

  test('the rule sees the three workflows that push a branch, so it is not vacuous', () => {
    const pushing = [...texts].filter(([, text]) => [...text.matchAll(TOKEN_PUSH)].length > 0);
    expect(pushing.map(([file]) => file)).toEqual([
      'bench.yml',
      'next-sync.yml',
      'security-channel.yml',
    ]);
  });
});

describe('unit · a mutated copy goes red', () => {
  const mutate = (file: string, from: string, to: string): readonly string[] => {
    const text = texts.get(file) ?? '';
    expect(text).toContain(from);
    return undispatchedPushes(file, text.replace(from, to));
  };

  test('security-channel.yml loses its dispatch', () => {
    expect(
      mutate('security-channel.yml', 'gh workflow run ci.yml --ref "$BRANCH"', 'true'),
    ).toEqual(['security-channel.yml:floors pushes "$BRANCH" and dispatches no ci.yml there']);
  });

  test('bench.yml loses actions: write', () => {
    expect(mutate('bench.yml', '  actions: write\n', '')).toEqual([
      'bench.yml:bench dispatches without actions: write',
    ]);
  });

  test('next-sync.yml dispatches a different branch than it pushed', () => {
    expect(
      mutate(
        'next-sync.yml',
        'gh workflow run ci.yml --ref next',
        'gh workflow run ci.yml --ref main',
      ),
    ).toEqual(['next-sync.yml:merge pushes next and dispatches no ci.yml there']);
  });
});
