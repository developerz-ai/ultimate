import { describe, expect, test } from 'bun:test';
// Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway root's lifetime, and
// `join` builds the host-separator path the committed floor is written to.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_TOKENS, fixProblem } from './error-contract';
import {
  floorProblemFindings,
  floorRequires,
  parseVerifyFloor,
  readVerifyFloor,
  VERIFY_FLOOR_FILE,
  vanishedSuiteFinding,
} from './verify-floor';

const DECLARED = ['unit', 'contract', 'job', 'e2e'] as const;

const parse = (text: string) => parseVerifyFloor(text, DECLARED);

const withRoot = async (
  files: Readonly<Record<string, string>>,
  assert: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-floor-'));
  try {
    for (const [name, body] of Object.entries(files)) await Bun.write(join(root, name), body);
    await assert(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · the suite floor', () => {
  test('a floor naming declared steps enforces exactly those', () => {
    const floor = parse('{"steps":["unit","contract"]}');
    expect(floor).toEqual({ steps: ['unit', 'contract'], problems: [] });
    expect(floorRequires(floor, 'contract')).toBe(true);
    expect(floorRequires(floor, 'job')).toBe(false);
  });

  // The whole point of the ratchet is that it is not advisory, so the file failing to parse may
  // never read as "nothing required": it reports, and it enforces nothing until it is fixed.
  test('a file that is not JSON enforces nothing and says why', () => {
    const floor = parse('steps: unit');
    expect(floor.steps).toEqual([]);
    expect(floor.problems[0]).toContain('does not parse as JSON');
  });

  test('a JSON file with no steps array is not a floor', () => {
    expect(parse('{"suites":["unit"]}').problems).toEqual([
      'it has no "steps" array of step names',
    ]);
    expect(parse('["unit"]').problems).toEqual(['it has no "steps" array of step names']);
    expect(parse('null').problems).toEqual(['it has no "steps" array of step names']);
  });

  // A typo enforces nothing at all — `contarct` can never apply, so pinning it would hold the gate
  // red forever, and dropping it silently would leave a floor everybody believes is covering a
  // suite it never names.
  test('a name no step declares is dropped and reported, never enforced', () => {
    const floor = parse('{"steps":["unit","contarct"]}');
    expect(floor.steps).toEqual(['unit']);
    expect(floor.problems).toEqual(['"steps" names contarct, which x verify does not run']);
    expect(floorRequires(floor, 'contarct')).toBe(false);
  });

  test('a non-string entry is reported rather than coerced', () => {
    const floor = parse('{"steps":["unit",7]}');
    expect(floor.steps).toEqual(['unit']);
    expect(floor.problems).toEqual(['"steps" holds an entry that is not a string']);
  });

  test('an empty floor is a floor: it requires nothing and reports nothing', () => {
    expect(parse('{"steps":[]}')).toEqual({ steps: [], problems: [] });
  });

  describe('reading it off disk', () => {
    test('no file is no floor, so an unratcheted repo is unchanged', async () => {
      await withRoot({}, async (root) => {
        expect(await readVerifyFloor(root)).toBeUndefined();
        expect(floorRequires(await readVerifyFloor(root), 'unit')).toBe(false);
      });
    });

    test('a committed file is parsed against the real step names', async () => {
      await withRoot({ [VERIFY_FLOOR_FILE]: '{"steps":["unit","budgets"]}' }, async (root) => {
        expect(await readVerifyFloor(root)).toEqual({
          steps: ['unit', 'budgets'],
          problems: [],
        });
      });
    });

    test('a floor problem becomes a finding the gate can report', async () => {
      await withRoot({ [VERIFY_FLOOR_FILE]: '{"steps":["nope"]}' }, async (root) => {
        const findings = floorProblemFindings(await readVerifyFloor(root));
        expect(findings).toHaveLength(1);
        expect(findings[0]?.code).toBe('X_CONFIG_INVALID');
        expect(findings[0]?.at).toBe(VERIFY_FLOOR_FILE);
      });
    });

    test('no floor is no findings', () => {
      expect(floorProblemFindings(undefined)).toEqual([]);
    });
  });

  // Axiom 4: the fix is the instruction. Both findings name the file, both name a runnable
  // command, and the `errors` step's own rule is what decides whether that is true.
  describe('every finding it emits is actionable as written', () => {
    const findings = [
      vanishedSuiteFinding('job'),
      ...floorProblemFindings({ steps: [], problems: ['it does not parse as JSON (x)'] }),
    ];

    test('the vanished-suite finding names the step, the file and both edits', () => {
      const finding = vanishedSuiteFinding('job');
      expect(finding.code).toBe('X_VERIFY_SUITE_VANISHED');
      expect(finding.cause).toContain('job');
      expect(finding.fix).toContain(VERIFY_FLOOR_FILE);
      expect(finding.docs).toBe('https://ultimate.dev/errors/X_VERIFY_SUITE_VANISHED');
    });

    test('no fix is advice: each passes the contract and carries a command token', () => {
      for (const finding of findings) {
        expect(fixProblem(finding.fix)).toBeUndefined();
        expect(COMMAND_TOKENS.some((token) => token.test(finding.fix))).toBe(true);
      }
    });
  });
});
