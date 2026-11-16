// `new-error-code --script <file>`: a code a repo script owns gets its never-ships entry and its
// row on a scratch copy of wiki/Error-Codes.md — no package registration, no HTTP status — and the
// gate's own reader (`gate-codes.ts`) sees both.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkGateCodes,
  NEVER_SHIPS_LEAD as GATE_LEAD,
  neverShipsList,
  tableRows,
} from './gate-codes';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { newErrorCode, WIKI_PAGE } from './new-error-code';
import { fixtureRoot, read, refusal, removeFixtureRoots } from './new-error-code.fixtures';
import { NEVER_SHIPS_LEAD, neverShipsIn, SCRIPT_SECTION } from './new-error-code-script';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

const scripted = (code: string, ...rest: string[]) => [
  code,
  '--script',
  'scripts/probe-guard.ts',
  '--title',
  'the probe guard read nothing',
  '--cause',
  'its glob matched no file in this layout',
  '--fix',
  'bun run scripts/probe-guard.ts --json',
  ...rest,
];

async function root(): Promise<string> {
  const dir = await fixtureRoot();
  await Bun.write(`${dir}/scripts/probe-guard.ts`, '// a guard\n');
  return dir;
}

describe('--script', () => {
  test('writes the never-ships entry and the row, and nothing else', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const result = await newErrorCode(dir, scripted('X_PROBE_GUARD_UNSCANNED'));
    expect(result.written).toEqual([WIKI_PAGE]);
    const after = await read(dir, WIKI_PAGE);
    expect(neverShipsList(before).has('X_PROBE_GUARD_UNSCANNED')).toBe(false);
    expect(neverShipsList(after).has('X_PROBE_GUARD_UNSCANNED')).toBe(true);
    expect(tableRows(after).has('X_PROBE_GUARD_UNSCANNED')).toBe(true);
    // The gate's own reader, as `gate-codes` runs it, finds neither gap for the new code.
    const gaps = checkGateCodes({
      declared: ['X_PROBE_GUARD_UNSCANNED'],
      page: after,
      noRowPins: [],
      unlistedPins: [],
    });
    expect(gaps.filter((gap) => gap.code === 'X_PROBE_GUARD_UNSCANNED')).toEqual([]);
    // In the scripts' section, as the last row of its code table.
    const lines = after.split('\n');
    const row = lines.findIndex((line) => line.startsWith('| `X_PROBE_GUARD_UNSCANNED` |'));
    const heading = lines.findLastIndex((line, index) => index < row && line.startsWith('## '));
    expect(lines[heading]).toBe(`## ${SCRIPT_SECTION}`);
    expect(lines[row]).toBe(
      '| `X_PROBE_GUARD_UNSCANNED` | the probe guard read nothing | its glob matched no file in this layout | `bun run scripts/probe-guard.ts --json` |',
    );
    // Everything but the two edits is byte-for-byte the page it read.
    const restored = after
      .replace(`${lines[row]}\n`, '')
      .replace(', `X_PROBE_GUARD_UNSCANNED`)', ')');
    expect(restored).toBe(before);
  });

  test('--dry-run reports both edits and writes neither', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const result = await newErrorCode(dir, scripted('X_PROBE_GUARD_DRY', '--dry-run'));
    expect(result.written).toEqual([]);
    expect(result.planned.map((edit) => edit.path)).toEqual([WIKI_PAGE]);
    expect(await read(dir, WIKI_PAGE)).toBe(before);
  });

  test('a code a wildcard already covers gets its row and no second list entry', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    expect(neverShipsList(before).has('X_ROADMAP_*')).toBe(true);
    await newErrorCode(dir, scripted('X_ROADMAP_PROBE_ROW'));
    const after = await read(dir, WIKI_PAGE);
    expect(after).not.toContain('`X_ROADMAP_PROBE_ROW`)');
    expect(tableRows(after).has('X_ROADMAP_PROBE_ROW')).toBe(true);
  });

  test('a script that is not in the tree, a package or a status beside it, and a known code are refused', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const missing = scripted('X_PROBE_A').map((word) =>
      word === 'scripts/probe-guard.ts' ? 'scripts/nope.ts' : word,
    );
    expect(await refusal(newErrorCode(dir, missing))).toBe('X_NEW_ERROR_CODE_INVALID');
    const outside = scripted('X_PROBE_B').map((word) =>
      word === 'scripts/probe-guard.ts' ? 'packages/money/src/errors.ts' : word,
    );
    expect(await refusal(newErrorCode(dir, outside))).toBe('X_NEW_ERROR_CODE_INVALID');
    for (const extra of [['--package', 'money'], ['--status', '422'], ['--off-socket']]) {
      expect(await refusal(newErrorCode(dir, scripted('X_PROBE_C', ...extra)))).toBe(
        'X_NEW_ERROR_CODE_INVALID',
      );
    }
    expect(await refusal(newErrorCode(dir, scripted('X_PIN_RAISE_UNSTATED')))).toBe(
      'X_NEW_ERROR_CODE_EXISTS',
    );
    expect(await read(dir, WIKI_PAGE)).toBe(before);
  });
});

describe('neverShipsIn', () => {
  test('appends inside the parenthesis, and refuses a page that has none', () => {
    const page = `x ${NEVER_SHIPS_LEAD}\`X_A\`, \`X_B\`) never ship.\n`;
    expect(neverShipsIn(page, 'X_C')).toBe(
      `x ${NEVER_SHIPS_LEAD}\`X_A\`, \`X_B\`, \`X_C\`) never ship.\n`,
    );
    expect(() => neverShipsIn('no list here', 'X_C')).toThrow();
  });

  test('its lead is the one gate-codes reads', () => {
    expect(NEVER_SHIPS_LEAD).toBe(GATE_LEAD);
  });
});
