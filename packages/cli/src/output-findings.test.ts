// What the render layer owes a reader on top of a finding as it was thrown: a fix they can run where
// `x` is not on PATH, and one line for one cause however many load paths reported it.

import { describe, expect, test } from 'bun:test';
import type { CommandResult, Finding } from './output';
import { renderHuman, renderJson } from './output';
import { collapseFindings, runnableFix } from './output-findings';

describe('runnableFix', () => {
  test.each([
    ['x db gen "add a"', 'bunx x db gen "add a"'],
    ['x verify', 'bunx x verify'],
    ['bun install && x db migrate', 'bun install && bunx x db migrate'],
    ['x db gen "a" && x db migrate', 'bunx x db gen "a" && bunx x db migrate'],
    ['METRICS_PORT=9091 x dev --json', 'METRICS_PORT=9091 bunx x dev --json'],
    // The tail of a line is an instruction as much as its head: `x` is on nobody's PATH there either.
    [
      'replace #f00 in a.scss, then: x verify --only boundaries',
      'replace #f00 in a.scss, then: bunx x verify --only boundaries',
    ],
    ['edit a.ts, then x db migrate', 'edit a.ts, then bunx x db migrate'],
    ['edit a.ts — re-run: x upgrade', 'edit a.ts — re-run: bunx x upgrade'],
    [
      'bunx biome check a.ts   # then x verify --only lint',
      'bunx biome check a.ts   # then bunx x verify --only lint',
    ],
    [
      'grants: []   // in a.ts, then: x db gen <name>',
      'grants: []   // in a.ts, then: bunx x db gen <name>',
    ],
    ['env -u DATABASE_URL x db migrate', 'env -u DATABASE_URL bunx x db migrate'],
    ['start it with `x dev`', 'start it with `bunx x dev`'],
    // An apostrophe opens no quote, or everything up to the next one would pass as an argument.
    [
      "add to its roles' grants, then x verify --only policy, in 'a.ts'",
      "add to its roles' grants, then bunx x verify --only policy, in 'a.ts'",
    ],
    [
      "add to its roles' grants, then x verify --only policy",
      "add to its roles' grants, then bunx x verify --only policy",
    ],
    [
      `in action "a"'s declaration, then x verify --only manifest`,
      `in action "a"'s declaration, then bunx x verify --only manifest`,
    ],
    [
      "tokens.role('fg'), then: x verify --only boundaries",
      "tokens.role('fg'), then: bunx x verify --only boundaries",
    ],
  ])('%s', (fix, runnable) => {
    expect(runnableFix(fix)).toBe(runnable);
  });

  test.each([
    // Quoted text is an argument, and the repo's own spelling already runs.
    ['git commit -m "before x upgrade"'],
    ['bun run x -- verify'],
    ['echo "x y && x z"'],
    ["echo 'a && x b'"],
    // Already runnable, and every other word.
    ['bunx x verify'],
    ['bun run verify'],
    ['xargs foo'],
    ['edit apps/web/x.ts'],
    ['set METRICS_PORT=<free port> in this environment'],
  ])('%s stays as it is', (fix) => {
    expect(runnableFix(fix)).toBe(fix);
  });

  test('applied once it is a no-op: a report read back and rendered again does not grow', () => {
    expect(runnableFix(runnableFix('x verify && x db migrate, then: x doctor'))).toBe(
      'bunx x verify && bunx x db migrate, then: bunx x doctor',
    );
  });
});

const failing = (findings: readonly Finding[]): CommandResult => ({
  ok: false,
  command: 'verify',
  summary: 'red',
  findings,
  steps: [{ name: 'manifest', ok: false, durationMs: 1, findings }],
});

const VIEW: Finding = { code: 'X_INVARIANT_VIOLATED', cause: 'posts.view: bad', fix: 'edit it' };

describe('both renderers', () => {
  const json = (result: CommandResult, runner?: boolean) =>
    JSON.parse(renderJson(result, false, { bunxRunner: runner === true })) as {
      findings: readonly Finding[];
      steps: readonly { findings: readonly Finding[] }[];
    };

  test('name bunx where the caller asked, in the findings and in each step', () => {
    const result = failing([{ code: 'X_A', cause: 'c', fix: 'x db migrate' }]);
    const human = renderHuman(result, false, { bunxRunner: true });
    expect(human).toContain('fix:   bunx x db migrate');
    expect(human).not.toContain('fix:   x db');
    expect(json(result, true).findings[0]?.fix).toBe('bunx x db migrate');
    expect(json(result, true).steps[0]?.findings[0]?.fix).toBe('bunx x db migrate');
  });

  test('leave the fix as thrown when the caller did not', () => {
    const result = failing([{ code: 'X_A', cause: 'c', fix: 'x db migrate' }]);
    expect(renderHuman(result)).toContain('fix:   x db migrate');
    expect(json(result).findings[0]?.fix).toBe('x db migrate');
  });

  test('a fix read out of a CI log is never rewritten: it is fenced, not an instruction', () => {
    const fenced: Finding = { code: 'X_A', cause: 'c', fix: 'x verify', source: 'ci-log' };
    expect(json(failing([fenced]), true).findings[0]?.fix).toBe('x verify');
  });

  test('one cause reported from three modules is one finding with its count', () => {
    const three = [
      { ...VIEW, at: 'a.ts' },
      { ...VIEW, at: 'b.ts' },
      { ...VIEW, at: 'c.ts' },
    ];
    const payload = json(failing(three));
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      at: 'a.ts',
      meta: { count: 3, reportedAt: ['a.ts', 'b.ts', 'c.ts'] },
    });
    expect(payload.steps[0]?.findings).toHaveLength(1);
    const human = renderHuman(failing(three));
    expect(human.match(/cause: /g)?.length).toBe(2);
    expect(human).toContain('posts.view: bad (reported 3 times: a.ts, b.ts, c.ts)');
  });
});

describe('collapseFindings', () => {
  test('a different cause or a different fix is a different finding', () => {
    const findings = [VIEW, { ...VIEW, cause: 'other' }, { ...VIEW, fix: 'other' }];
    expect(collapseFindings(findings)).toEqual(findings);
  });

  test('a lone finding keeps its identity, and its meta survives a count', () => {
    expect(collapseFindings([VIEW])[0]).toBe(VIEW);
    const withMeta: Finding = { ...VIEW, meta: { step: 'lint' } };
    expect(collapseFindings([withMeta, withMeta])[0]?.meta).toEqual({
      step: 'lint',
      count: 2,
    });
  });
});
