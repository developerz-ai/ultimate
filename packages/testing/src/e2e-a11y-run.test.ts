// One test's audit over a page double: what is kept, what a reasoned `allow` drops, what the
// suite already told, the one retry a navigation earns, and the refusals — a port with no tree, an
// `allow` with no reason. The real browser half is `e2e-a11y.e2e.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { AxTreeNode } from './ax-node';
import { CdpCallFailedError } from './cdp-errors';
import type { A11yAllow } from './e2e-a11y-run';
import { checkAllow, E2eA11yViolationError, startA11yRun } from './e2e-a11y-run';
import type { AxTreeRequest, E2eBrowserPage } from './e2e-page';

const unnamed: AxTreeNode = {
  role: 'button',
  roleType: 'role',
  name: '',
  ignored: false,
  backendNodeId: 7,
};
const titled: AxTreeNode = {
  role: 'RootWebArea',
  roleType: 'internalRole',
  name: 'Feed',
  ignored: false,
};
const CLEAN_PROBE = JSON.stringify({
  lang: true,
  root: { html: '<html>', matches: [] },
  hidden: [],
});

interface Double {
  readonly page: E2eBrowserPage;
  readonly requests: AxTreeRequest[];
}

/** A page whose tree is `nodes`, described as the tab would: markup plus the selectors matched. */
const pageWith = (
  nodes: readonly AxTreeNode[],
  options: { url?: string; probe?: string; failFirst?: unknown } = {},
): Double => {
  const requests: AxTreeRequest[] = [];
  let failing = options.failFirst;
  return {
    requests,
    page: {
      url: () => options.url ?? 'http://app.test/feed',
      goto: () => Promise.resolve(undefined),
      evaluate: () => Promise.resolve(options.probe ?? CLEAN_PROBE),
      click: () => Promise.resolve(),
      accessibilityTree: (request) => {
        requests.push(request);
        if (failing !== undefined) {
          const error = failing;
          failing = undefined;
          return Promise.reject(error);
        }
        return Promise.resolve(
          nodes.map((n) =>
            request.describe(n)
              ? { ...n, html: '<button id="close"></button>', matches: request.selectors.slice() }
              : n,
          ),
        );
      },
    },
  };
};

const verdictOf = (run: { verdict(): void }): unknown => {
  try {
    run.verdict();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('startA11yRun', () => {
  test('an unnamed button fails the verdict with the code, its markup and the url', async () => {
    const run = startA11yRun(pageWith([titled, unnamed]).page, [], new Set());
    await run.check();
    const error = verdictOf(run);
    expect(error).toBeInstanceOf(E2eA11yViolationError);
    const violation = error as E2eA11yViolationError;
    expect(violation.code).toBe('X_E2E_A11Y_VIOLATION');
    expect(violation.cause).toContain('<button id=\\"close\\"></button>');
    expect(violation.cause).toContain('http://app.test/feed');
    expect(violation.fix).toContain('role: "button"');
    expect(violation.fix).toContain('because');
  });

  test('a page with nothing to find passes, and only flagged nodes are described', async () => {
    const double = pageWith([titled]);
    const run = startA11yRun(double.page, [], new Set());
    await run.check();
    expect(verdictOf(run)).toBeUndefined();
    expect(double.requests[0]?.describe(titled)).toBe(false);
    expect(double.requests[0]?.describe(unnamed)).toBe(true);
  });

  test('the probe’s findings fail it too: no lang', async () => {
    const probe = JSON.stringify({
      lang: false,
      root: { html: '<html>', matches: [] },
      hidden: [],
    });
    const run = startA11yRun(pageWith([titled], { probe }).page, [], new Set());
    await run.check();
    expect(String(verdictOf(run))).toContain('lang RootWebArea');
  });

  test('a reasoned allow for that role and selector drops it; another role does not', async () => {
    const allow: A11yAllow[] = [{ role: 'button', selector: '#close', because: 'icon-only close' }];
    const run = startA11yRun(pageWith([titled, unnamed]).page, allow, new Set());
    await run.check();
    expect(verdictOf(run)).toBeUndefined();

    const wrongRole = [{ ...allow[0], role: 'link' } as A11yAllow];
    const other = startA11yRun(pageWith([titled, unnamed]).page, wrongRole, new Set());
    await other.check();
    expect(verdictOf(other)).toBeInstanceOf(E2eA11yViolationError);
  });

  test('one finding read twice is told once, and a later test of the suite is not told again', async () => {
    const reported = new Set<string>();
    const first = startA11yRun(pageWith([titled, unnamed]).page, [], reported);
    await first.check();
    await first.check();
    expect((verdictOf(first) as E2eA11yViolationError).cause).toStartWith('1 element(s)');
    const second = startA11yRun(pageWith([titled, unnamed]).page, [], reported);
    await second.check();
    expect(verdictOf(second)).toBeUndefined();
  });

  test('a document that committed under the read is read once more, not failed', async () => {
    const failFirst = new CdpCallFailedError({
      method: 'DOM.resolveNode',
      detail: 'No node with given id found',
    });
    const double = pageWith([titled, unnamed], { failFirst });
    const run = startA11yRun(double.page, [], new Set());
    await run.check();
    expect(double.requests).toHaveLength(2);
    expect(verdictOf(run)).toBeInstanceOf(E2eA11yViolationError);
  });

  test('any other failure of the read is thrown at once', async () => {
    const failFirst = new CdpCallFailedError({ method: 'x', detail: 'the connection closed' });
    const run = startA11yRun(pageWith([titled], { failFirst }).page, [], new Set());
    await expect(run.check()).rejects.toThrow(/X_CDP/);
  });

  test('a tab no test navigated is no app’s page: about:blank is not audited', async () => {
    const double = pageWith([unnamed], { url: 'about:blank' });
    const run = startA11yRun(double.page, [], new Set());
    await run.check();
    expect(double.requests).toHaveLength(0);
    expect(verdictOf(run)).toBeUndefined();
  });

  test('a document that is not markup (JSON in the browser’s viewer) is not audited', async () => {
    const probe = JSON.stringify({
      html: false,
      lang: false,
      root: { html: '<html>' },
      hidden: [],
    });
    const double = pageWith([unnamed], { probe });
    const run = startA11yRun(double.page, [], new Set());
    await run.check();
    expect(double.requests).toHaveLength(0);
    expect(verdictOf(run)).toBeUndefined();
  });

  test('a port with no accessibilityTree refuses by name rather than skipping', async () => {
    const { accessibilityTree: _, ...port } = pageWith([unnamed]).page;
    const run = startA11yRun(port, [], new Set());
    await expect(run.check()).rejects.toThrow(/accessibilityTree/);
  });
});

describe('checkAllow', () => {
  test('no options is no exceptions', () => {
    expect(checkAllow(undefined)).toEqual([]);
  });

  test('every entry needs a role, a selector and a non-blank because', () => {
    const entry = { role: 'button', selector: '#x', because: 'icon-only, named by its tooltip' };
    expect(checkAllow({ allow: [entry] })).toEqual([entry]);
    for (const bad of [
      { ...entry, because: '' },
      { ...entry, because: '   ' },
      { ...entry, role: '' },
      { ...entry, selector: ' ' },
    ]) {
      expect(() => checkAllow({ allow: [bad] })).toThrow(/X_E2E_A11Y_VIOLATION/);
    }
  });
});
