// Single responsibility: pins the ISO-shape predicate, and proves `t.date` and `coerceNode` give
// the same answers under two host zones — the refusal set must not depend on `TZ`.
import { describe, expect, test } from 'bun:test';
import { coerceNode } from './coerce';
import { isIsoDateTime } from './iso-date';

const REFUSED = [
  'March 14, 2026',
  '3/14/2026',
  '12',
  '2026',
  'Sat Mar 14 2026',
  '2026-03-14T09:00',
  '2026-03-14 09:00:00',
  '14-03-2026',
  '2026-3-14',
  ' 2026-03-14',
];
const ACCEPTED = [
  '2026-03-14',
  '2026-03-14T09:00Z',
  '2026-03-14T09:00:00Z',
  '2026-03-14T09:00:00.123Z',
  '2026-03-14T09:00:00+01:00',
  '2026-03-14T09:00:00-0400',
  '2026-03-14 09:00:00Z',
];

describe('isIsoDateTime', () => {
  test.each(REFUSED)('refuses %p', (value) => {
    expect(isIsoDateTime(value)).toBe(false);
  });

  test.each(ACCEPTED)('accepts %p', (value) => {
    expect(isIsoDateTime(value)).toBe(true);
  });
});

// Two `bun -e` subprocesses — the only way to hold a different `TZ` — each answering the WHOLE set in
// one run, and spawned CONCURRENTLY: the sequential pair cost two cold module graphs back to back
// and timed out at bun's 5 s default on a loaded CI runner (release PR #567). The budget is stated
// because a cold `bun` start is outside this file's control; the assertion is not loosened.
const SUBPROCESS_BUDGET_MS = 60_000;

describe('the refusal set is the same under every host zone', () => {
  test(
    't.date and coerceNode answer identically under TZ=UTC and TZ=America/New_York',
    async () => {
      const source = [
        `import { t, coerceNode, validate } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};`,
        `const inputs = ${JSON.stringify([...REFUSED, ...ACCEPTED])};`,
        'const answers = {};',
        'for (const input of inputs) {',
        '  const r = validate(t.date, input);',
        '  const c = coerceNode({ kind: "date" }, input);',
        '  answers[input] = [r.issues === undefined ? r.value.toISOString() : "refused",',
        '    c instanceof Date ? c.toISOString() : "untouched"];',
        '}',
        'console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, answers }));',
      ].join('\n');
      type Answers = { zone: string; answers: Record<string, [string, string]> };
      const readIn = async (zone: string): Promise<Answers> => {
        const child = Bun.spawn(['bun', '-e', source], {
          env: { ...process.env, TZ: zone },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        // A crashed child otherwise surfaces as `JSON Parse error` on an empty string.
        if (exitCode !== 0)
          throw new TypeError(`bun -e under TZ=${zone} exited ${exitCode}: ${stderr}`);
        return JSON.parse(stdout.trim()) as Answers;
      };
      const [utc, newYork] = await Promise.all([readIn('UTC'), readIn('America/New_York')]);
      // The control: the subprocesses really do carry different zones.
      expect([utc.zone, newYork.zone]).toEqual(['UTC', 'America/New_York']);
      expect(newYork.answers).toEqual(utc.answers);
      for (const input of REFUSED) expect(utc.answers[input]).toEqual(['refused', 'untouched']);
      for (const input of ACCEPTED) expect(utc.answers[input]?.[0]).not.toBe('refused');
    },
    SUBPROCESS_BUDGET_MS,
  );

  test('a non-ISO query value reaches validation untouched', () => {
    expect(coerceNode({ kind: 'date' }, '3/14/2026')).toBe('3/14/2026');
  });
});
