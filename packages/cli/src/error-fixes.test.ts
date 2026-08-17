// The projection that turned `x errors explain` from a shrug into an instruction. What is asserted
// hardest: that a code's answer is the text its own throw site writes, that a pair is only made
// inside ONE object literal, and that the two fallbacks say what they do not know instead of
// naming a command that cannot close the code.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadErrorCatalog } from './error-catalog';
import { fixProblem } from './error-contract';
import {
  codeFixes,
  codeFixScan,
  loadCodeFixes,
  resetCodeFixes,
  scanScopeFixes,
} from './error-fixes';
import { explainErrorCode } from './mcp-errors';
import { scanCodeFixSites } from './ts-scan';

// The same number `REPO_SCAN_TIMEOUT_MS` (scripts/lib/run.ts) fixes for every whole-repo scan, and
// the same literal `error-catalog.test.ts` already uses here: a package's own suite may not import
// the host monorepo's scripts, so the value is repeated rather than the dependency created.
const REPO_SCAN_MS = 30_000;

const temporary: string[] = [];

afterAll(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scopeWith(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'x-fixes-'));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  return dir;
}

describe('unit · scanCodeFixSites', () => {
  test('pairs a code with the fix written beside it', () => {
    const source = [
      'export const boom = () =>',
      '  new UltimateError({',
      "    code: 'X_TEAPOT',",
      "    cause: 'the pot is short',",
      "    fix: 'x doctor --json',",
      '  });',
    ].join('\n');
    expect(scanCodeFixSites(source, 'a/src/b.ts')).toEqual([
      { at: 'a/src/b.ts', line: 3, code: 'X_TEAPOT', fix: 'x doctor --json' },
    ]);
  });

  // The whole rule is adjacency. Without it a file declaring five errors would hand every one of
  // them whichever fix the scanner happened to reach first, which is worse than no answer.
  test('never pairs a code with a fix from the object next to it', () => {
    const source = [
      "const a = { code: 'X_ONE', cause: \"c\", fix: 'x verify --json' };",
      "const b = { code: 'X_TWO', cause: 'c' };",
    ].join('\n');
    const sites = scanCodeFixSites(source, 'a/src/b.ts');
    expect(sites.find((site) => site.code === 'X_ONE')?.fix).toBe('x verify --json');
    expect(sites.find((site) => site.code === 'X_TWO')).toEqual({
      at: 'a/src/b.ts',
      line: 2,
      code: 'X_TWO',
    });
  });

  // A fix with two literals needs a parser to read: `'a' + 'b'` is one string and `p ? 'a' : 'b'`
  // is two, and publishing one branch as the whole fix is a command that does the wrong half.
  test('reports the site with no fix when the fix has more than one literal', () => {
    const ternary = "throw x({ code: 'X_ONE', fix: p ? 'x dev --json' : 'x doctor --json' });";
    expect(scanCodeFixSites(ternary, 'a/src/b.ts')).toEqual([
      { at: 'a/src/b.ts', line: 1, code: 'X_ONE' },
    ]);
    const computed = "throw x({ code: 'X_TWO', fix: fixFor(input) });";
    expect(scanCodeFixSites(computed, 'a/src/b.ts')).toEqual([
      { at: 'a/src/b.ts', line: 1, code: 'X_TWO' },
    ]);
  });

  // The contract's own 3-line rendering appears verbatim in doc blocks all over this repo.
  test('reads neither a code nor a fix out of a comment', () => {
    const source = ["// code: 'X_ONE', fix: 'x verify --json'", 'export const nothing = 1;'].join(
      '\n',
    );
    expect(scanCodeFixSites(source, 'a/src/b.ts')).toEqual([]);
  });

  test('a top-level assignment is not an object literal, so it pairs with nothing', () => {
    const source = [
      "const code = 'X_ONE';",
      "export const other = { fix: 'x verify --json' };",
    ].join('\n');
    expect(scanCodeFixSites(source, 'a/src/b.ts')).toEqual([]);
  });
});

describe('unit · scanScopeFixes', () => {
  test('walks a scope and names each site the way x docs names a file', async () => {
    const scope = await scopeWith({
      'render/src/errors.ts': "throw x({ code: 'X_TEAPOT', fix: 'x routes --json' });",
      'render/src/errors.test.ts': "throw x({ code: 'X_FROM_A_TEST', fix: 'no' });",
    });
    const index = await scanScopeFixes(scope);
    expect(index.get('X_TEAPOT')).toEqual([
      { at: '@ultimat3/render/src/errors.ts', line: 1, code: 'X_TEAPOT', fix: 'x routes --json' },
    ]);
    // A test file's throw sites are fixtures, not the framework's instructions.
    expect(index.get('X_FROM_A_TEST')).toBeUndefined();
  });

  // `Bun.Glob.scan` does not follow directory symlinks unless told to, and a package directory
  // under `node_modules/@ultimat3` is a symlink under `bun link` and under any workspace an app
  // resolves without realpath. The default answer there was an empty index and no sign of one.
  test('a linked package is walked, not skipped', async () => {
    const real = await scopeWith({
      'render/src/errors.ts': "throw x({ code: 'X_TEAPOT', fix: 'x routes --json' });",
    });
    const linked = await mkdtemp(join(tmpdir(), 'x-fixes-link-'));
    temporary.push(linked);
    await symlink(join(real, 'render'), join(linked, 'render'), 'dir');
    expect([...(await scanScopeFixes(linked)).keys()]).toEqual(['X_TEAPOT']);
  });

  // `${…}` is a value only the throw site has. Blanked to the same `<value>` the `errors` step
  // judges a fix line in, so the two surfaces read one string identically.
  test('blanks an interpolation the way the gate does', async () => {
    const scope = await scopeWith({
      // Written as a template with an escaped `\${`, so the fixture holds a real interpolation
      // without this file itself containing a `${` inside a plain string (`noTemplateCurlyInString`).
      'render/src/errors.ts': `throw x({ code: 'X_TEAPOT', fix: \`x g island \${name}\` });`,
    });
    expect((await scanScopeFixes(scope)).get('X_TEAPOT')?.[0]?.fix).toBe('x g island <value>');
  });
});

describe('unit · errors.explain projects the throw site', () => {
  test(
    'a framework code answers with the fix its own source writes',
    async () => {
      await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      // `@ultimat3/mcp` raises this in exactly one place, so the answer is that line verbatim —
      // no note, no gate command, nothing this table wrote down a second time.
      expect(explainErrorCode('X_MCP_TOOL_UNSAFE')?.fix).toBe(
        "add policy: '<resource>:<verb>' to the tool, reusing the permission its action uses",
      );
      expect(codeFixes().get('X_MCP_TOOL_UNSAFE')?.[0]?.at).toBe('@ultimat3/mcp/src/errors.ts');
    },
    REPO_SCAN_MS,
  );

  test(
    'the overwhelming majority of registered codes now carry a real instruction',
    async () => {
      const [, index] = await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      const projected = [...index.values()].filter((sites) =>
        sites.some((site) => site.fix !== undefined),
      );
      // A floor, not an equality: codes come and go, and a test that had to be edited on every new
      // error would be edited without being read. It fails the moment the projection stops working.
      expect(projected.length).toBeGreaterThan(150);
    },
    REPO_SCAN_MS,
  );

  test(
    'no answer is the generic gate command any more',
    async () => {
      await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      // The single line that stood for 327 codes. `X_UNAUTHENTICATED` is the clearest case: the
      // gate never raises it, so "x verify --json" reported green and left the reader where they
      // started.
      expect(explainErrorCode('X_UNAUTHENTICATED')?.fix).not.toBe('x verify --json');
      expect(explainErrorCode('X_TIMEOUT')?.fix).not.toBe('x verify --json');
    },
    REPO_SCAN_MS,
  );

  test(
    'every answer it can give is a line the error contract accepts',
    async () => {
      const [, index] = await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      const offenders: string[] = [];
      for (const code of index.keys()) {
        const fix = explainErrorCode(code)?.fix;
        if (fix === undefined) continue;
        const problem = fixProblem(fix);
        if (problem !== undefined) offenders.push(`${code}: ${problem}`);
      }
      expect(offenders).toEqual([]);
    },
    REPO_SCAN_MS,
  );
});

describe('unit · the three honest fallbacks', () => {
  test(
    'a code whose throw site computes its fix leads with the file, and with no verb',
    async () => {
      await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      // Render builds this one from the route's own declared modes, so there is no literal to read.
      const fix = explainErrorCode('X_ROUTE_MODE_INVALID')?.fix ?? '';
      expect(fix).toStartWith('@ultimat3/render/src/errors.ts:');
      expect(fix).not.toContain('x verify --json');
      // `open …` read as a program: `open(1)` on macOS, `xdg-open` on Linux, `command not found`
      // on a CI runner. There is no command for this condition, and inventing one is the same
      // axiom-4 failure as the gate command this replaced — one step further along.
      expect(fix).not.toMatch(/^(open|edit|view|cat|less|vim|code)\b/);
      expect(fixProblem(fix)).toBeUndefined();
    },
    REPO_SCAN_MS,
  );

  // Loaded, NOT reset. `resetCodeFixes()` empties the index for every code alike, so the assertion
  // would have held for a reason that has nothing to do with X_DRAINING — it would still pass if
  // core grew a readable throw site for it tomorrow.
  test(
    'a code nothing in the installed framework raises says exactly that',
    async () => {
      await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
      expect(codeFixes().get('X_DRAINING')).toBeUndefined();
      expect(codeFixScan()).toBe('read');
      const fix = explainErrorCode('X_DRAINING')?.fix ?? '';
      expect(fix).toContain('nothing in the installed framework raises X_DRAINING');
      expect(fixProblem(fix)).toBeUndefined();
    },
    REPO_SCAN_MS,
  );

  // The third case is the one an empty index used to be indistinguishable from: nothing LOOKED.
  // Asserting the same code both ways is what proves the two lines are chosen by `codeFixScan()`
  // and not by the code. Last in the file, because it leaves the index reset.
  test('an unread index says the packages could not be read, never that nothing raises the code', () => {
    resetCodeFixes();
    expect(codeFixScan()).toBe('unread');
    const fix = explainErrorCode('X_DRAINING')?.fix ?? '';
    expect(fix).toContain('could not be read');
    expect(fix).not.toContain('nothing in the installed framework raises');
    expect(fixProblem(fix)).toBeUndefined();
  });
});
