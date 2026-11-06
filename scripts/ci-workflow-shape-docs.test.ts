// The docs site's publish (plan 101, 42-adopt-docs-site): inert until the owner sets
// DOCS_SITE_ORIGIN, started only by a finished ci run on main or by hand, publishing only beside
// the docs site's own gate verdict, and building at the production origin so robots.txt opens.
// Split from `ci-workflow-shape.test.ts` at its ceiling.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, type Job, jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { GATED_APPS } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const FILE = 'deploy-docs-site.yml';
const APP = 'dummy/docs-site';
const GATE = "vars.DOCS_SITE_ORIGIN != ''";

const deploy = await readWorkflow(FILE);
const raw: unknown = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/workflows/${FILE}`).text(),
);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const jobs = Object.entries(deploy.jobs ?? {});

describe(`unit · ${FILE} · inert until the owner turns it on`, () => {
  test('every job opens its if with the DOCS_SITE_ORIGIN gate', () => {
    expect(jobs.length).toBeGreaterThan(0);
    for (const [, job] of jobs) expect(text(job.if).trim().startsWith(GATE)).toBe(true);
  });

  test('only a finished ci run on main, or a dispatch, starts it: never a push or a PR', () => {
    const on = record(record(raw)['on']);
    expect(Object.keys(on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(on['workflow_run']).toEqual({
      workflows: ['ci'],
      types: ['completed'],
      branches: ['main'],
    });
  });

  test('the only write permission is the Pages deploy`s, on the deploy job alone', () => {
    expect(record(raw)['permissions']).toEqual({ contents: 'read', checks: 'read' });
    const writers = jobs.filter(([, job]) =>
      JSON.stringify(job.permissions ?? {}).includes('write'),
    );
    expect(writers.map(([name]) => name)).toEqual(['deploy']);
  });
});

describe(`unit · ${FILE} · publishes only what the docs site's own gate passed`, () => {
  const build: Job = jobOf(deploy, 'build');
  const verdict = (build.steps ?? []).find((step) => step.env?.['CHECK'] !== undefined);

  test('the verdict it reads is the matrix job ci.yml runs for this app', async () => {
    expect(GATED_APPS.map((app) => app.dir)).toContain(APP);
    expect(verdict?.env?.['CHECK']).toBe(`reference-app-verify (${APP})`);
    const ci = await readWorkflow('ci.yml');
    expect(jobOf(ci, 'reference-app-verify').strategy?.matrix?.['app']).toContain(APP);
    expect(verdict?.env?.['REUSED_BY']).toBe('tested');
  });

  test('a skip is accepted only beside tested, as the demo publish accepts it', () => {
    const run = text(verdict?.run);
    expect(run).toContain('"skipped"');
    expect(run).toContain('$REUSED_BY');
    expect(run.match(/skipped/g)?.length).toBe(run.match(/"skipped"/g)?.length);
  });

  test('the build is the app`s own static build, at the production origin', () => {
    const step = (build.steps ?? []).find((one) =>
      text(one.run).includes('x build --target static'),
    );
    expect(step?.['working-directory']).toBe(APP);
    expect(step?.env?.['ULTIMATE_ENV']).toBe('production');
    expect(step?.env?.['SITE_ORIGIN']).toBe(expr('vars.DOCS_SITE_ORIGIN'));
  });
});
