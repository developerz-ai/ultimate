// `new-error-code --script <file>`: a code a repo script owns gets its never-ships entry on a
// scratch copy of wiki/Error-Codes.md and its row on wiki/Error-Codes-scripts.md — no package
// registration, no HTTP status — and the gate's own reader (`gate-codes.ts`) sees both.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkGateCodes,
  NEVER_SHIPS_LEAD as GATE_LEAD,
  neverShipsList,
  tableRows,
} from './gate-codes';
import { INDEX_CLOSE, INDEX_OPEN } from './lib/error-code-index';
import { codeRows, ownerPage } from './lib/error-code-pages';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { ScriptError } from './lib/script-error';
import { newErrorCode, WIKI_PAGE } from './new-error-code';
import { fixtureRoot, read, refusal, removeFixtureRoots } from './new-error-code.fixtures';
import { NEVER_SHIPS_LEAD, neverShipsIn, SCRIPT_OWNER } from './new-error-code-script';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

const SCRIPTS_PAGE = ownerPage(SCRIPT_OWNER);
/** The index outside its generated block: the part a script code edits by hand, its list. */
const outsideIndex = (text: string): string =>
  text.slice(0, text.indexOf(INDEX_OPEN)) + text.slice(text.indexOf(INDEX_CLOSE));

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
  test('writes the never-ships entry, the row on the scripts page and the index, nothing else', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const pageBefore = await read(dir, SCRIPTS_PAGE);
    const result = await newErrorCode(dir, scripted('X_PROBE_GUARD_UNSCANNED'));
    expect(result.written).toEqual([SCRIPTS_PAGE, WIKI_PAGE]);
    const after = await read(dir, WIKI_PAGE);
    const page = await read(dir, SCRIPTS_PAGE);
    expect(neverShipsList(before).has('X_PROBE_GUARD_UNSCANNED')).toBe(false);
    expect(neverShipsList(after).has('X_PROBE_GUARD_UNSCANNED')).toBe(true);
    expect(tableRows(page).has('X_PROBE_GUARD_UNSCANNED')).toBe(true);
    expect(after).toContain('| X_PROBE_GUARD_UNSCANNED | [scripts](Error-Codes-scripts) |');
    // The gate's own reader, as `gate-codes` runs it, finds neither gap for the new code.
    const gaps = checkGateCodes({
      declared: ['X_PROBE_GUARD_UNSCANNED'],
      page: after,
      pages: [after, page],
      noRowPins: [],
      unlistedPins: [],
    });
    expect(gaps.filter((gap) => gap.code === 'X_PROBE_GUARD_UNSCANNED')).toEqual([]);
    // At its place in code order on the scripts page.
    const row =
      '| `X_PROBE_GUARD_UNSCANNED` | the probe guard read nothing | its glob matched no file in this layout | `bun run scripts/probe-guard.ts --json` |';
    const codes = codeRows(page).map((one) => one.codes[0] ?? '');
    const at = codes.indexOf('X_PROBE_GUARD_UNSCANNED');
    expect((codes[at - 1] ?? '') < 'X_PROBE_GUARD_UNSCANNED').toBe(true);
    expect((codes[at + 1] ?? 'X_~') > 'X_PROBE_GUARD_UNSCANNED').toBe(true);
    // Everything but the edits is byte-for-byte what it read: the row, and the list entry.
    expect(page.replace(`${row}\n`, '')).toBe(pageBefore);
    expect(outsideIndex(after).replace(', `X_PROBE_GUARD_UNSCANNED`)', ')')).toBe(
      outsideIndex(before),
    );
  });

  test('--dry-run reports both edits and writes neither', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const result = await newErrorCode(dir, scripted('X_PROBE_GUARD_DRY', '--dry-run'));
    expect(result.written).toEqual([]);
    expect(result.planned.map((edit) => edit.path)).toEqual([SCRIPTS_PAGE, WIKI_PAGE]);
    expect(await read(dir, WIKI_PAGE)).toBe(before);
  });

  test('a code a wildcard already covers gets its row and no second list entry', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    expect(neverShipsList(before).has('X_ROADMAP_*')).toBe(true);
    await newErrorCode(dir, scripted('X_ROADMAP_PROBE_ROW'));
    const after = await read(dir, WIKI_PAGE);
    expect(after).not.toContain('`X_ROADMAP_PROBE_ROW`)');
    expect(tableRows(await read(dir, SCRIPTS_PAGE)).has('X_ROADMAP_PROBE_ROW')).toBe(true);
  });

  test('a script that is not in the tree, a package or a status beside it, and a known code are refused', async () => {
    const dir = await root();
    const before = await read(dir, WIKI_PAGE);
    const pageBefore = await read(dir, SCRIPTS_PAGE);
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
    expect(await read(dir, SCRIPTS_PAGE)).toBe(pageBefore);
  });
});

describe('--script refusals speak the --script form', () => {
  const fixOf = async (run: Promise<unknown>): Promise<string> =>
    run.then(
      () => expect.unreachable('the generator wrote where it had to refuse'),
      (error: unknown) => (error instanceof ScriptError ? `${error.cause} | ${error.fix}` : ''),
    );

  test('a missing --cause names --script, never --package', async () => {
    const dir = await root();
    const argv = scripted('X_PROBE_D').filter((_, index, all) => all[index - 1] !== '--cause');
    const said = await fixOf(
      newErrorCode(
        dir,
        argv.filter((word) => word !== '--cause'),
      ),
    );
    expect(said).toContain('--script scripts/');
    expect(said).not.toContain('--package');
  });

  test('a mistyped flag beside --script is refused in the --script form', async () => {
    const dir = await root();
    const said = await fixOf(newErrorCode(dir, scripted('X_PROBE_E', '--titel', 'x')));
    expect(said).toContain('--titel');
    expect(said).toContain('--script scripts/');
    expect(said.split(' | ')[1]).not.toContain('--package');
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
