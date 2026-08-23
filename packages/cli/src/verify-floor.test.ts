// The ratchet's own tests. A floor that reads wrong is a gate that is green over a suite nobody
// runs — the exact false green it exists to close — so every way the file can be malformed is
// pinned here, and so is the rule that both findings it emits are runnable as written.

import { describe, expect, test } from 'bun:test';
// Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway root's lifetime, and
// `join` builds the host-separator path the committed floor is written to.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { fixProblem } from './error-contract';
import { explainErrorCode } from './mcp-errors';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';
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

/**
 * Input that hands the parse's catch a value the process did not build. `JSON.parse` over a string
 * raises a `SyntaxError` and nothing else, so a hostile throwable only reaches that catch through
 * the `ToString` the parse performs first — which is where the two tests below inject one.
 */
const thrower = (thrown: unknown): string =>
  ({
    toString(): string {
      throw thrown;
    },
  }) as unknown as string;

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

  // Both halves of `error instanceof Error ? error.message : String(error)` are reads on a value
  // nothing here constructed, and each dies on its own shape — so one test per shape, or the
  // half that still works hides the half that does not.
  test('a null-prototype throwable is described, where String() would have thrown', () => {
    const refused = Object.create(null) as unknown;
    // The raw form this replaced, proven to die rather than assumed to.
    expect(() => String(refused)).toThrow();

    const floor = parse(thrower(refused));
    expect(floor.steps).toEqual([]);
    expect(floor.problems[0]).toContain('does not parse as JSON');
  });

  test('a proxy refusing getPrototypeOf is described, where instanceof would have thrown', () => {
    // A `TypeError` because that is what the engine itself raises on a proxy invariant violation,
    // so the trap stands in for a real one rather than for a convenient one.
    const trapped = new Proxy(
      {},
      {
        getPrototypeOf: (): never => {
          throw new TypeError('this proxy answers no prototype');
        },
      },
    );
    expect(() => trapped instanceof Error).toThrow();

    const floor = parse(thrower(trapped));
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
      expect(finding.docs).toBe(ERROR_DOCS_URL);
    });

    // "Runnable as written" is decided against this build, not by shape: everything before the `#`
    // is what a shell would execute, so the registry has to hold that command and the real parser
    // has to accept its flags — the check `mcp-errors.test.ts` makes of the same code's MCP entry.
    // A regex over the line would have blessed `x verfy --jsn` exactly as readily. Everything after
    // the `#` is a comment the shell drops, which is what lets one line carry both remedies.
    test('each fix runs verbatim: a shipped command first, every alternative behind a #', () => {
      for (const finding of findings) {
        expect(fixProblem(finding.fix)).toBeUndefined();
        const argv = (finding.fix.split('#')[0] ?? '').trim().split(/\s+/);
        expect(argv[0]).toBe('x');
        const spec = commandFor(argv[1] ?? '')?.spec;
        expect(spec?.name).toBe(argv[1]);
        expect(spec?.summary.endsWith('(planned)')).toBe(false);
        expect(() => parseArgs(argv.slice(1), SPECS)).not.toThrow();
        // Axiom 4 again: the agent that ran a machine-readable command to get here is handed one.
        expect(argv).toContain('--json');
      }
    });

    // A fix that ran the gate and said nothing else would leave an author with the failure and no
    // edit, so both remedies have to survive the split the shell makes.
    test('the comment half still carries the edits, so nothing is lost to the #', () => {
      const [vanished, malformed] = findings;
      expect(vanished?.fix.split('#')[1]).toContain(VERIFY_FLOOR_FILE);
      expect(vanished?.fix.split('#')[1]).toContain('job');
      expect(malformed?.fix.split('#')[1]).toContain('"steps"');
    });

    // Two surfaces answer for this one code — the finding `runVerify` prints, and `errors.explain`
    // for the agent that asked the MCP host instead — and the tables live in different modules, so
    // nothing but this stops one from drifting off the other. Neither is scripted to perform the
    // edit: a command that rewrites the floor is the gate ratcheting its own ratchet, so what both
    // offer to repeat is the run that proves the suite is back.
    test('errors.explain answers this code with the same command and the same two edits', () => {
      const finding = vanishedSuiteFinding('job');
      const explained = explainErrorCode('X_VERIFY_SUITE_VANISHED');
      const command = (fix: string) => (fix.split('#')[0] ?? '').trim();
      expect(command(explained?.fix ?? '')).toBe(command(finding.fix));
      expect(explained?.fix).toContain('restore the');
      expect(explained?.fix).toContain(`drop its name from ${VERIFY_FLOOR_FILE}`);
      expect(explained?.docs).toBe(finding.docs);
    });
  });
});
