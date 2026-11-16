// The pin edit every ratchet's `over` finding prints, and the text `--write-pin` drafts: proved on
// the three row shapes the pins tables really use, and against the real tables for the placeholder
// that must never reach a commit.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { FIX_PROSE_PIN_TARGET } from '../fix-prose';
import { FIX_SHELL_ARG_PIN_TARGET } from '../fix-shell-arg';
import { NODE_IMPORT_PIN_TARGET } from '../node-imports';
import { PROTO_INDEX_PIN_TARGET } from '../proto-index';
import { SECRET_COMPARE_PIN_TARGET } from '../secret-compare';
import { SPAWN_TIMEOUT_PIN_TARGET } from '../spawn-timeout';
import { REAL_SLEEP_PIN_TARGET } from '../test-real-sleep';
import {
  applyPinRaise,
  PIN_WHY_PLACEHOLDER,
  pinRaiseFix,
  pinRaiseOf,
  placeholderFindings,
  treePlaceholderFindings,
} from './pin-edit';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { ScriptError } from './script-error';

// A test here reads the real tree: the repo-scan budget, never Bun's 5 s default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const COUNT_TABLE = `// header
export const THING_PINS_FILE = 'scripts/lib/thing-pins.ts';

export const THING_PINS: Readonly<Record<string, number>> = {
  cli: 3,
  'odd-pkg': 1, // why: an old reason
};
`;

const OBJECT_TABLE = `export const ROW_PINS: Readonly<Record<string, RowPin>> = {
  cli: {
    // why: the reason written for 2
    count: 2,
    reason: 'the sentence',
  },
  'scripts/a.ts: x === y': {
    count: 1,
    reason: 'a site row',
  },
};
`;

const TARGET = {
  script: 'scripts/thing.ts',
  file: 'scripts/lib/thing-pins.ts',
  table: 'THING_PINS',
} as const;

describe('pinRaiseOf / pinRaiseFix: the edit an over finding prints', () => {
  test('names the file, the key, old → new and the why: placeholder, and the command that drafts it', () => {
    const raise = pinRaiseOf(TARGET, { pkg: 'cli', found: 5, pinned: 3 });
    expect(raise).toEqual({ ...TARGET, key: 'cli', from: 3, to: 5, name: 'cli' });
    const fix = pinRaiseFix(raise);
    expect(fix).toContain('scripts/lib/thing-pins.ts');
    expect(fix).toContain('THING_PINS.cli 3 → 5');
    expect(fix).toContain(PIN_WHY_PLACEHOLDER);
    expect(fix).toContain('bun run scripts/thing.ts --write-pin cli');
  });

  test('a key that is no identifier is spelt as an index, and a name that is no shell word is a placeholder', () => {
    const raise = pinRaiseOf(
      { ...TARGET, nameOf: (key) => key.slice(0, key.indexOf(': ')) },
      { pkg: "scripts/a.ts: x === y && $(rm -rf ~)'", found: 2, pinned: 1 },
    );
    const fix = pinRaiseFix(raise);
    expect(fix).toContain(`THING_PINS['scripts/a.ts: x === y && $(rm -rf ~)\\'']`);
    expect(fix).toContain('--write-pin scripts/a.ts');
    const unsafe = pinRaiseFix(pinRaiseOf(TARGET, { pkg: '$(boom)', found: 1, pinned: 0 }));
    expect(unsafe).toContain('--write-pin <the row key>');
    expect(unsafe).not.toContain('--write-pin $(boom)');
  });
});

describe('applyPinRaise: the draft --write-pin writes', () => {
  test('a flat row is raised, with the placeholder on the line above, its trailing why kept', () => {
    const raise = pinRaiseOf(TARGET, { pkg: 'odd-pkg', found: 4, pinned: 1 });
    const text = applyPinRaise(COUNT_TABLE, raise);
    expect(text).toContain(`  ${PIN_WHY_PLACEHOLDER}\n  'odd-pkg': 4, // why: an old reason\n`);
    expect(text).toContain('  cli: 3,\n');
  });

  test('an object row has its count raised, the placeholder directly above the count', () => {
    const raise = pinRaiseOf({ ...TARGET, table: 'ROW_PINS' }, { pkg: 'cli', found: 3, pinned: 2 });
    const text = applyPinRaise(OBJECT_TABLE, raise);
    expect(text).toContain(
      `    // why: the reason written for 2\n    ${PIN_WHY_PLACEHOLDER}\n    count: 3,\n    reason: 'the sentence',`,
    );
    // Only that row: the site row's count is untouched.
    expect(text).toContain("'scripts/a.ts: x === y': {\n    count: 1,");
  });

  test('an absent row is added at the end of the table, in the shape its type declares', () => {
    const counted = applyPinRaise(
      COUNT_TABLE,
      pinRaiseOf(TARGET, { pkg: 'new-pkg', found: 2, pinned: 0 }),
    );
    expect(counted).toContain("  'odd-pkg': 1, // why: an old reason\n");
    expect(counted).toEndWith(`  ${PIN_WHY_PLACEHOLDER}\n  'new-pkg': 2,\n};\n`);
    const site = applyPinRaise(
      OBJECT_TABLE,
      pinRaiseOf(
        { ...TARGET, table: 'ROW_PINS' },
        { pkg: 'scripts/b.ts: a !== b', found: 1, pinned: 0 },
      ),
    );
    // A blank reason: the ratchet reports it unexplained until a person writes the sentence.
    expect(site).toEndWith(
      `  'scripts/b.ts: a !== b': {\n    ${PIN_WHY_PLACEHOLDER}\n    count: 1,\n    reason: '',\n  },\n};\n`,
    );
  });

  test('an empty table literal grows its first row', () => {
    const empty = 'export const REAL_SLEEP_PINS: Readonly<Record<string, number>> = {};\n';
    const text = applyPinRaise(
      empty,
      pinRaiseOf({ ...TARGET, table: 'REAL_SLEEP_PINS' }, { pkg: 'core', found: 1, pinned: 0 }),
    );
    expect(text).toBe(
      `export const REAL_SLEEP_PINS: Readonly<Record<string, number>> = {\n  ${PIN_WHY_PLACEHOLDER}\n  core: 1,\n};\n`,
    );
  });

  test('a key matched literally: `a.b` never raises `axb`', () => {
    const table = 'export const T: Readonly<Record<string, number>> = {\n  axb: 1,\n};\n';
    const text = applyPinRaise(
      table,
      pinRaiseOf({ ...TARGET, table: 'T' }, { pkg: 'a.b', found: 2, pinned: 0 }),
    );
    expect(text).toContain('  axb: 1,\n');
    expect(text).toContain("'a.b': 2,");
  });

  test('a file without the table is refused with a code, never edited somewhere else', () => {
    let caught: unknown;
    try {
      applyPinRaise(
        COUNT_TABLE,
        pinRaiseOf({ ...TARGET, table: 'MISSING_PINS' }, { pkg: 'cli', found: 4, pinned: 3 }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptError);
    expect((caught as ScriptError).code).toBe('X_PIN_EDIT_UNPLACED');
  });
});

describe('the placeholder never reaches a commit', () => {
  test('a pins file still holding the draft line is a finding naming its line', () => {
    const drafted = applyPinRaise(
      COUNT_TABLE,
      pinRaiseOf(TARGET, { pkg: 'cli', found: 4, pinned: 3 }),
    );
    const findings = placeholderFindings([{ path: TARGET.file, text: drafted }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_PIN_RAISE_UNSTATED');
    expect(findings[0]?.at).toBe(`${TARGET.file}:5`);
    expect(placeholderFindings([{ path: TARGET.file, text: COUNT_TABLE }])).toEqual([]);
  });

  test('no pins table in this tree holds it', async () => {
    expect(await treePlaceholderFindings(repoRoot())).toEqual([]);
  });
});

describe('every ratchet that prints a raise names a table that is there', () => {
  const targets = [
    FIX_PROSE_PIN_TARGET,
    FIX_SHELL_ARG_PIN_TARGET,
    NODE_IMPORT_PIN_TARGET,
    PROTO_INDEX_PIN_TARGET,
    SECRET_COMPARE_PIN_TARGET,
    SPAWN_TIMEOUT_PIN_TARGET,
    REAL_SLEEP_PIN_TARGET,
  ];
  for (const target of targets) {
    test(`${target.script} → ${target.file} ${target.table}`, async () => {
      const root = repoRoot();
      expect(await Bun.file(`${root}/${target.script}`).exists()).toBe(true);
      const source = await Bun.file(`${root}/${target.file}`).text();
      // The draft lands in the declared table: a raise on a fresh row writes inside it, not elsewhere.
      const drafted = applyPinRaise(
        source,
        pinRaiseOf(target, { pkg: 'pin-edit-probe', found: 1, pinned: 0 }),
      );
      expect(drafted).not.toBe(source);
      expect(placeholderFindings([{ path: target.file, text: drafted }])).toHaveLength(1);
    });
  }
});
