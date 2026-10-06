// The enforcement half of `scripts/url-pathname.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a module URL's `.pathname` read as a filesystem path coming back fails
// `bun run verify` with no extra wiring.
//
// The fixtures below spell the refused shape on purpose, which is why `SELF_TEST` exempts this file.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  SELF_TEST,
  scanUrlPathname,
  urlPathnameFindingFor,
  urlPathnameFindings,
  urlPathnameSites,
} from './url-pathname';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const lines = (source: string): readonly number[] =>
  scanUrlPathname('packages/x/src/a.ts', source).map((site) => site.line);

describe('a module URL read as a path', () => {
  test('a direct .pathname on new URL(…, import.meta.url) is refused, with its line', () => {
    expect(lines("const a = 1;\nconst ROOT = new URL('..', import.meta.url).pathname;")).toEqual([
      2,
    ]);
  });

  test('new URL(import.meta.url).pathname — the file itself — is refused', () => {
    expect(lines('const self = new URL(import.meta.url).pathname;')).toEqual([1]);
  });

  test('a call spread over lines is still one call', () => {
    expect(
      lines(
        "const biome = new URL(\n  '../../node_modules/.bin/biome',\n  import.meta.url,\n)\n  .pathname;",
      ),
    ).toEqual([1]);
  });

  test('a template-literal specifier, parentheses and all, is read to its closing paren', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    expect(lines('const s = (n) => new URL(`./${f(n)}.scss`, import.meta.url).pathname;')).toEqual([
      1,
    ]);
  });

  test('a ) inside the specifier string is not the call closing', () => {
    expect(lines("const odd = new URL('./a).ts', import.meta.url).pathname;")).toEqual([1]);
  });

  test('a URL bound to a name and read through it later is refused at the read', () => {
    expect(
      lines("const here = new URL('./glyphs/', import.meta.url);\nconst dir = here.pathname;"),
    ).toEqual([2]);
  });

  test('a template that EMITS the shape into an app is refused: the app inherits it', () => {
    expect(
      lines('const body = "const ROOT = new URL(\'..\', import.meta.url).pathname;";'),
    ).toEqual([1]);
  });
});

describe('a file URL built from a string', () => {
  test('a file:// template base is refused outright: the path in it is never encoded', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    expect(lines('const a = 1;\nconst u = new URL(spec, `file://${from}`).pathname;')).toEqual([2]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    expect(lines('const u = new URL(spec, `file://${from}`);')).toEqual([1]);
  });

  test('a file:// template or concatenation as the input is the same bug', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    expect(lines('const u = new URL(`file://${path}`);')).toEqual([1]);
    expect(lines("const u = new URL(spec, 'file://' + from);")).toEqual([1]);
  });

  test('the finding names the file-URL fix, not the .pathname one', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — the literal ${…} is the case under test
    const [site] = scanUrlPathname('packages/x/src/a.ts', 'new URL(`file://${p}`);');
    if (site === undefined) expect.unreachable('the scan found the site');
    expect(urlPathnameFindingFor(site).fix).toContain('Bun.pathToFileURL(');
  });
});

describe('a destructured pathname', () => {
  test('const { pathname } = new URL(…, import.meta.url) is refused', () => {
    expect(lines("const a = 1;\nconst { pathname } = new URL('..', import.meta.url);")).toEqual([
      2,
    ]);
    expect(lines("const { pathname: dir } = new URL('.', import.meta.url);")).toEqual([1]);
  });

  test('destructuring an HTTP URL is a route, and stays silent', () => {
    expect(lines("const { pathname } = new URL(href, 'https://app.test');")).toEqual([]);
    expect(lines("const { href } = new URL('..', import.meta.url);")).toEqual([]);
  });
});

describe('what the rule stays silent about', () => {
  test('the two fixes', () => {
    expect(lines("const a = Bun.fileURLToPath(new URL('..', import.meta.url));")).toEqual([]);
    expect(lines('const c = Bun.fileURLToPath(new URL(spec, Bun.pathToFileURL(from)));')).toEqual(
      [],
    );
    expect(lines("const d = new URL('file:///etc/passwd');")).toEqual([]);
    expect(lines("const b = join(import.meta.dir, '..');")).toEqual([]);
  });

  test('a URL handed to Bun.file whole, which Bun opens correctly', () => {
    expect(lines("await Bun.file(new URL('./a.json', import.meta.url)).text();")).toEqual([]);
  });

  test('an HTTP URL’s pathname is a route, not a path on disk', () => {
    expect(lines('const route = new URL(request.url).pathname;')).toEqual([]);
    expect(lines("const u = new URL(href, 'http://x');\nconst p = u.pathname;")).toEqual([]);
  });

  test('a comment naming the shape as the thing that was removed', () => {
    expect(lines("// was: new URL('..', import.meta.url).pathname\nconst a = 1;")).toEqual([]);
  });

  test('a binding of the same name in another file is not this file’s URL', () => {
    expect(lines('const here = other();\nconst dir = here.pathname;')).toEqual([]);
  });
});

describe('the finding', () => {
  const finding = (): ReturnType<typeof urlPathnameFindingFor> => {
    const [site] = scanUrlPathname(
      'packages/x/src/a.ts',
      'const r = new URL(".", import.meta.url).pathname;',
    );
    if (site === undefined) expect.unreachable('the scan found the site');
    return urlPathnameFindingFor(site);
  };

  test('names the code, the site, and opens its fix with the code shape to paste', () => {
    expect(finding().code).toBe('X_URL_PATHNAME_AS_PATH');
    expect(finding().at).toBe('packages/x/src/a.ts:1');
    expect(finding().fix.startsWith('Bun.fileURLToPath(new URL(')).toBe(true);
    expect(finding().fix).toContain('import.meta.dir');
  });
});

describe('this tree', () => {
  test('the self-test exemption names this file and nothing else', () => {
    expect(SELF_TEST).toBe('scripts/url-pathname.test.ts');
  });

  test('read the framework and both tracked apps', async () => {
    const { files } = await urlPathnameSites(repoRoot());
    expect(files.some((path) => path.startsWith('packages/ui/src/'))).toBe(true);
    expect(files.some((path) => path.startsWith('examples/dummy/'))).toBe(true);
    expect(files.some((path) => path.startsWith('dummy/social-media-clone/'))).toBe(true);
    expect(files.some((path) => path.includes('/node_modules/'))).toBe(false);
  });

  test('holds no module URL read as a filesystem path', async () => {
    expect(await urlPathnameFindings(repoRoot())).toEqual([]);
  });
});
