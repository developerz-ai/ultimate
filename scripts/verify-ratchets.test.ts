// The CLI verdict of every pin ratchet is the gate's verdict: each `scripts/lib/<n>-pins.ts` whose
// ratchet script exists is reached from `scripts/verify-host-checks.ts`, or is named below with the
// gate step that really runs it. `finite-bounds` was red on main for five sites while every gate
// step was green, because nothing the gate runs ever called it.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { RATCHET_CHECKS, RATCHET_SCRIPTS } from './verify-ratchets';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const text = (path: string): Promise<string> => Bun.file(`${ROOT}/${path}`).text();

/**
 * Pins tables a host check does NOT read, each with the place that does — checked to be true below,
 * so an exemption cannot outlive the wiring it names.
 */
const RUN_ELSEWHERE: Readonly<Record<string, { readonly by: string; readonly needle: string }>> = {
  // why: per-package coverage is the CI `packages` job's own question (`coverage-gate.ts --all`),
  // a full test run per unit — far past a host check's budget, and `x verify` has no such step.
  coverage: { by: '.github/workflows/ci.yml', needle: 'scripts/coverage-gate.ts' },
  // why: the `[Unreleased]`-claims rule is half of `changelogFindings`, which the unit step runs
  // over the real tree; it reads release tags `git` may have to fetch, never a host check's job.
  'unreleased-claim': {
    by: 'scripts/changelog-check.test.ts',
    needle: 'changelogFindings(repoRoot())',
  },
};

/** The ratchet script a pins file belongs to, when its name says so: `<n>.ts`, `<n>s.ts`, `<n>-gate.ts`, `<n>-links.ts`, `<n>-citations.ts`. */
async function scriptFor(name: string): Promise<string | undefined> {
  const stem = name.replace(/-unpinned$/, '');
  for (const candidate of [
    name,
    `${name}s`,
    `${name}-gate`,
    `${stem}-links`,
    `${name}-citations`,
  ]) {
    if (await Bun.file(`${ROOT}/scripts/${candidate}.ts`).exists())
      return `scripts/${candidate}.ts`;
  }
  return undefined;
}

/** Every `./x` module a file imports, as `scripts/x.ts`. */
const importsOf = (source: string, from = 'scripts'): readonly string[] =>
  [...source.matchAll(/from '\.\/([\w./-]+)'/g)].map((match) => `${from}/${match[1]}.ts`);

describe('every pin ratchet is on the gate', () => {
  test('a pins table with a ratchet script is reached from the host checks, or exempted with its runner', async () => {
    const host = await text('scripts/verify-host-checks.ts');
    const direct = new Set(importsOf(host));
    // One hop: `error-render.ts` carries `fix-shell-arg` into the errors step.
    const reached = new Set(direct);
    for (const module of direct) {
      if (!(await Bun.file(`${ROOT}/${module}`).exists())) continue;
      for (const next of importsOf(await text(module))) reached.add(next);
    }
    const pins = [...new Bun.Glob('scripts/lib/*-pins.ts').scanSync({ cwd: ROOT })].map((path) =>
      path.replaceAll('\\', '/').replace(/^scripts\/lib\/(.*)-pins\.ts$/, '$1'),
    );
    expect(pins.length).toBeGreaterThan(20);
    const unwired: string[] = [];
    for (const name of pins.sort()) {
      if (Object.hasOwn(RUN_ELSEWHERE, name)) continue;
      const script = await scriptFor(name);
      if (script === undefined) {
        unwired.push(
          `${name}: no ratchet script by its name — add one to RUN_ELSEWHERE with its runner`,
        );
      } else if (!reached.has(script)) {
        unwired.push(`${name}: ${script} is not reached from scripts/verify-host-checks.ts`);
      }
    }
    expect(unwired).toEqual([]);
  });

  test('each exemption is really run where it says', async () => {
    for (const [name, where] of Object.entries(RUN_ELSEWHERE)) {
      expect(await Bun.file(`${ROOT}/scripts/lib/${name}-pins.ts`).exists(), name).toBe(true);
      expect(await text(where.by), `${name} → ${where.by}`).toContain(where.needle);
    }
  });

  test('the ratchets this module wires are in the errors step, one check each', async () => {
    const host = await text('scripts/verify-host-checks.ts');
    expect(host).toContain('...RATCHET_CHECKS');
    expect(RATCHET_CHECKS).toHaveLength(RATCHET_SCRIPTS.length);
  });
});
