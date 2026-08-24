// The gate-step rule, over fixtures rather than over the tree: a page three other agents are
// rewriting is not a place to assert a negative case from.

import { describe, expect, test } from 'bun:test';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import {
  checkGateSteps,
  gateStepFinding,
  RUN_THRESHOLD,
  readStepPages,
  STEP_GLOBS,
  skipStepPath,
} from './gate-steps';
import { repoRoot } from './lib/run';

const STEPS = ['typecheck', 'lint', 'contract', 'contract-diff', 'seo', 'i18n', 'roadmap'];
const page = (text: string) => ({ path: 'wiki/Fixture.md', text });

/**
 * Every case carries a CONTROL page that states the count correctly, because a corpus stating
 * nothing at all is itself a finding — `vacuous` — and a negative case must fail for the reason it
 * names rather than for reading an empty corpus.
 */
const CONTROL = { path: 'wiki/Control.md', text: '`x verify` runs 7 steps.' };
const gaps = (text: string) => checkGateSteps({ pages: [page(text), CONTROL], steps: STEPS });

describe('the count rule', () => {
  test('accepts the number this build runs', () => {
    expect(gaps('`x verify` runs 7 steps.')).toEqual([]);
  });

  test('reports a stale total and names the number it should hold', () => {
    const [gap] = gaps('the gate — 17 steps, in this order');
    if (gap === undefined) return expect.unreachable('a stale total must be reported');
    expect(gap.kind).toBe('count');
    expect(gap.detail).toContain('7');
    expect(gateStepFinding(gap, STEPS).fix).toContain('to 7');
  });

  test('reads the word form, because a page spells it out', () => {
    expect(gaps('`x verify`. Seventeen steps, in this order:')[0]?.kind).toBe('count');
  });

  test("reads the total out of the gate's own summary line, with no other context", () => {
    expect(gaps('✓ 14 of 17 steps passed in 11153ms')[0]?.kind).toBe('count');
  });

  test('refuses a passed count above the total', () => {
    const [gap] = gaps('✓ 9 of 7 steps passed');
    expect(gap?.kind).toBe('passed');
  });

  test('leaves a step count that is not the gate alone', () => {
    // `packages/jobs/CLAUDE.md` writes "20,000 steps" about a backfill's pages.
    expect(gaps('a backfill over a million rows — 20000 steps, ~200M compares')).toEqual([]);
  });

  test('leaves a SUBSET count alone — a pin is not the total', () => {
    expect(gaps('`x verify` — pinned red on 4 steps in gated-apps.ts')).toEqual([]);
  });

  test('leaves an older release naming its own count alone', () => {
    expect(gaps('`x verify`: 1.0.0 shipped 17 steps')).toEqual([]);
  });
});

describe('a count the shipped rule could not read', () => {
  test('`16 of 18` — the word `steps` elsewhere in the sentence, which README.md wrote', () => {
    // Measured on `README.md:334`: the row said `16 of 18` beside `pinned on 4 steps` and the
    // check was green over it. The gate runs 19.
    const [gap] = gaps('the demo passes its own gate: 16 of 18. `typecheck` is pinned on 4 steps');
    if (gap === undefined) return expect.unreachable('a loose tally must be reported');
    expect(gap.kind).toBe('count');
    expect(gap.detail).toContain('states 18 steps');
  });

  test('`2 red of 17` — the phrasing an app CLAUDE.md uses for its ratchet', () => {
    const [gap] = gaps('this app pins 2 red of 17 as of 2026-08-19, and every other step is green');
    expect(gap?.kind).toBe('count');
    expect(gap?.quote).toBe('2 red of 17');
  });

  test('a tally of something ELSE on a line about steps is left alone', () => {
    // `CLAUDE.md:184`, `wiki/Contributing.md:177` and `wiki/Known-Gaps.md:78` all write `N of 30`
    // about PACKAGES on a line that also says `step`. A rule reporting them is one readers silence.
    expect(
      gaps('a step of the gate — 24 of 30 packages silent on `sideEffects` on day one'),
    ).toEqual([]);
  });

  test('a spelled-out total with no `steps` after it — how packages/cli/README.md wrote it', () => {
    const [gap] = gaps('Seventeen, in cost order, defined once as `VERIFY_STEP_NAMES`.');
    if (gap === undefined) return expect.unreachable('a spelled-out total must be reported');
    expect(gap.kind).toBe('count');
    expect(gap.detail).toContain('states 17 steps');
  });

  test('a spelled-out MEASUREMENT is not a total', () => {
    // `wiki/Tutorial-02-First-Feature.md:209`: "a twenty-line script — this one passes `x verify`".
    expect(gaps('a twenty-line script — this one passes `x verify`:')).toEqual([]);
  });
});

describe('the list rule', () => {
  const full = STEPS.join(', ');

  test('accepts the list in the order the gate runs it', () => {
    expect(gaps(`the gate — 7 steps: ${full}`)).toEqual([]);
  });

  test('reports an enumeration that omits an inserted step, and names it', () => {
    const [gap] = gaps('the gate — 7 steps: typecheck, lint, contract, contract-diff, roadmap');
    expect(gap?.kind).toBe('list');
    expect(gap?.detail).toBe('omits seo, i18n');
  });

  test('does not read a SUBSET of the steps as the whole list', () => {
    // The six test types name several steps and neither anchor.
    expect(gaps('the six test types: contract, live, job, e2e, eval')).toEqual([]);
  });

  test('a step name inside a longer word is not a citation', () => {
    // `wiki/FAQ.md` sits `lives` before `typecheck` in the same sentence as the list. Reading it as
    // `live` reported the one correct enumeration in the tree as mis-ordered.
    expect(gaps(`a check that lives only in CI. 7 steps: ${full}`)).toEqual([]);
  });

  test('`contract` inside `contract-diff` is not a second citation', () => {
    expect(gaps(`7 steps: ${full}`)).toEqual([]);
  });
});

describe('a list that WRAPS, which a line-at-a-time rule cannot see', () => {
  test('a bare run of step names across two lines is read as one list', () => {
    // `packages/cli/README.md` presents the list exactly this way and shipped 17 of 19 names under
    // a green check: the enumeration rule anchors on the first and last name being on ONE line.
    const [gap] = gaps('typecheck lint contract\ncontract-diff roadmap');
    if (gap === undefined) return expect.unreachable('a wrapped list must be reported');
    expect(gap.kind).toBe('list');
    expect(gap.detail).toBe('omits seo, i18n');
  });

  test('the same run, complete and in order, is silent', () => {
    expect(gaps('typecheck lint contract\ncontract-diff seo i18n roadmap')).toEqual([]);
  });

  test('a paragraph with PROSE in it is a sentence about steps, not the list', () => {
    expect(gaps('run lint then contract then contract-diff then seo then i18n')).toEqual([]);
  });

  test('a run below the threshold is a citation, not a list claiming completeness', () => {
    expect(RUN_THRESHOLD).toBe(5);
    expect(gaps('`lint` `contract` `contract-diff` `seo`')).toEqual([]);
  });

  /**
   * A one-line paragraph IS its own line, so a bare run holding the first and last step satisfies
   * `enumeratesGate` and `bareRun` both, at the same `at` — and reported twice, one stale list read
   * as two defects.
   */
  test('a one-line bare run holding the first and last step is reported once', () => {
    const found = gaps('typecheck lint contract contract-diff roadmap');
    expect(found.map((gap) => `${gap.kind} ${gap.at} ${gap.detail}`)).toEqual([
      'list wiki/Fixture.md:1 omits seo, i18n',
    ]);
  });

  /** And the wrapped case must still be seen: dedupe by position may not cost the run rule a line. */
  test('a run the line rule cannot see is still reported by the paragraph rule', () => {
    expect(gaps('lint contract contract-diff seo i18n').map((gap) => gap.kind)).toEqual(['list']);
  });
});

describe('the vacuous guard', () => {
  test('a corpus stating nothing is a finding, not a green', () => {
    const [gap] = checkGateSteps({ pages: [page('nothing to see')], steps: STEPS });
    if (gap === undefined) return expect.unreachable('an empty corpus must be reported');
    expect(gap.kind).toBe('vacuous');
    expect(gateStepFinding(gap, STEPS).code).toBe('X_DOC_GATE_STEPS_UNSCANNED');
  });
});

describe('what is history and not a claim', () => {
  test.each(['docs/plans/2026/08/12/x.md', 'CHANGELOG.md'])('skips %s', (path) => {
    expect(skipStepPath(path)).toBe(true);
  });

  test('reads a wiki page', () => {
    expect(skipStepPath('wiki/CLI-Reference.md')).toBe(false);
  });

  test('skips a .test.ts — a fixture stating a wrong count is INPUT, not a claim', () => {
    expect(skipStepPath('scripts/gate-steps.test.ts')).toBe(true);
    expect(skipStepPath('scripts/gate-steps.ts')).toBe(false);
  });
});

describe('the surfaces the scan reaches', () => {
  test('llms.txt, a workflow, a script header and an agent brief are all read', async () => {
    // Each stated a step count and none was scanned: the rule read `.md` only, so `llms.txt` said
    // `eighteen steps` and omitted `i18n` under a green check.
    const paths = (await readStepPages(repoRoot())).map((page) => page.path);
    expect(paths).toContain('llms.txt');
    expect(paths).toContain('.github/workflows/ci.yml');
    expect(paths).toContain('scripts/reference-app-gate.ts');
    expect(paths.some((path) => path.startsWith('.claude/'))).toBe(true);
  });

  /**
   * GitHub Actions accepts both spellings, so a rule reading one of them is a rule a single
   * `git mv ci.yml ci.yaml` walks out of. Asserted on the GLOB list rather than on a file, because
   * this repo happens to spell every workflow `.yml` and a discovery test cannot prove the absence.
   */
  test('a .yaml workflow is in the scanned set, not only .yml', () => {
    expect(STEP_GLOBS).toContain('.github/workflows/*.yaml');
    expect(STEP_GLOBS).toContain('.github/workflows/*.yml');
  });

  test("and packages/cli/README.md's wrapped list is read as a run, not as nothing", async () => {
    const pages = await readStepPages(repoRoot());
    const readme = pages.find((page) => page.path === 'packages/cli/README.md');
    if (readme === undefined) return expect.unreachable('packages/cli/README.md must be scanned');
    // Drop one name from the page's own list: the run rule must now name the hole. The neighbour is
    // DERIVED rather than written: this fixture spelled ` i18n manifest` and silently stopped
    // mutating anything the day `policy` was inserted between them, so the assertion below failed
    // against a page that was correct. A literal pair here goes stale on the next inserted step.
    const after = VERIFY_STEP_NAMES[VERIFY_STEP_NAMES.indexOf('i18n') + 1] ?? '';
    const broken = { path: readme.path, text: readme.text.replace(` i18n ${after}`, ` ${after}`) };
    const gaps = checkGateSteps({ pages: [broken], steps: [...VERIFY_STEP_NAMES] });
    expect(gaps.some((gap) => gap.kind === 'list' && gap.detail === 'omits i18n')).toBe(true);
  });
});
