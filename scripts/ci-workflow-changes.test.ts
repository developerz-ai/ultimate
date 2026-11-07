// The `changes` job's shape: it asks `scripts/ci-changes.ts` over a diff that lists both halves of a
// move, and only the jobs no prose can reach read its answer — never the gate or its verdict.

import { describe, expect, test } from 'bun:test';
import { expr, type Job, jobOf, readWorkflow, text } from './lib/ci-workflow-read';

const ci = await readWorkflow('ci.yml');
const job = (name: string): Job => jobOf(ci, name);
const changes = job('changes');
const steps = changes.steps ?? [];
const runs = steps.map((step) => text(step.run)).join('\n');

describe('unit · ci.yml · a prose-only diff skips the heavy jobs, never the verdict', () => {
  test('changes waits on nothing, never skips itself, and exposes the classifier`s answer', () => {
    expect(changes.needs).toBeUndefined();
    expect(changes.if).toBeUndefined();
    const outputs: unknown = (changes as Readonly<Record<string, unknown>>)['outputs'];
    expect(outputs).toEqual({ heavy: expr('steps.classify.outputs.heavy') });
    const classify = steps.find((step) => step.id === 'classify');
    expect(text(classify?.run)).toContain('bun run scripts/ci-changes.ts');
    expect(text(classify?.run)).toContain('.data.heavy');
  });

  // A rename listed by its new name alone hides the code it moved out of `packages/`.
  test('every diff lists both halves of a move, and a pull request diffs its merge commit', () => {
    const diffs = [...runs.matchAll(/git diff [^\n>]*/g)].map((m) => m[0]);
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    expect(diffs.filter((diff) => !diff.includes('--no-renames'))).toEqual([]);
    expect(runs).toContain('HEAD^1 HEAD');
    const checkout = steps.find((step) => text(step.uses).startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(2);
  });

  // `x verify merge` is red for a step no part reported, and the doc guards read exactly the files
  // `changes` skips for: the gate, its verdict, `packages` and the app gates never hear the answer.
  test('the verdict and the jobs that read prose never wait on changes', () => {
    for (const name of ['gate', 'verify', 'packages', 'reference-app-verify', 'deploy-proof']) {
      const target = job(name);
      expect({ [name]: JSON.stringify([target.needs, target.if]).includes('changes') }).toEqual({
        [name]: false,
      });
    }
  });

  // Fail-open: only an explicit `false` skips, so a red, cancelled or silent `changes` runs all.
  test('no job reads the answer as anything but "not false"', () => {
    const readers = Object.entries(ci.jobs ?? {})
      .map(([name, target]) => [name, text(target.if)] as const)
      .filter(([, condition]) => condition.includes('needs.changes'));
    expect(readers.length).toBe(6);
    for (const [name, condition] of readers) {
      expect({ [name]: condition.includes("needs.changes.outputs.heavy != 'false'") }).toEqual({
        [name]: true,
      });
      expect({ [name]: /needs\.changes\.outputs\.heavy (==|!=) 'true'/.test(condition) }).toEqual({
        [name]: false,
      });
    }
  });
});
