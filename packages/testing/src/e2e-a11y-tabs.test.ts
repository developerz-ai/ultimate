// The raw-tab audit over page doubles: a navigation's findings and the test-end read both fail the
// test from `endTabA11y`, a tab an `e2eTest` runner claimed is never judged twice, a closed tab is
// not read but what it found is told, and a finding is told once. The real browser half is
// `e2e-a11y.e2e.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { AxTreeNode } from './ax-node';
import { E2eA11yViolationError, startA11yRun } from './e2e-a11y-run';
import { allowA11y, auditTab, endTabA11y } from './e2e-a11y-tabs';
import type { E2eBrowserPage } from './e2e-page';

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

let serial = 0;

/** A page whose tree is whatever `nodes` holds when asked, at a url of its own. */
const pageDouble = (nodes: AxTreeNode[]) => {
  serial += 1;
  const url = `http://app.test/tab-${String(serial)}`;
  let reads = 0;
  const page: E2eBrowserPage = {
    url: () => url,
    goto: () => Promise.resolve(undefined),
    evaluate: () => Promise.resolve(CLEAN_PROBE),
    click: () => Promise.resolve(),
    accessibilityTree: (request) => {
      reads += 1;
      return Promise.resolve(
        nodes.map((n) =>
          request.describe(n)
            ? { ...n, html: `<button id="b${String(serial)}">`, matches: request.selectors.slice() }
            : n,
        ),
      );
    },
  };
  return { page, url, reads: () => reads };
};

const unnamed = (): AxTreeNode => ({
  role: 'button',
  roleType: 'role',
  name: '',
  ignored: false,
  backendNodeId: 7,
});

const ended = async (): Promise<string> => {
  try {
    await endTabA11y();
    return 'passed';
  } catch (error) {
    return String(error);
  }
};

describe('every raw tab is audited, with no line in the suite', () => {
  test('an unnamed button a navigation landed on fails the test at its end, naming the page', async () => {
    const double = pageDouble([titled, unnamed()]);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    await tab.navigated();
    const told = await ended();
    expect(told).toContain('X_E2E_A11Y_VIOLATION');
    expect(told).toContain(double.url);
  });

  test('a clean navigation passes, and the next test starts with nothing kept', async () => {
    const tab = auditTab(pageDouble([titled]).page, () => Promise.resolve(true));
    await tab.navigated();
    expect(await ended()).toBe('passed');
    expect(await ended()).toBe('passed');
  });

  test('a tab the test only CALLED is read at its end: a dialog opened after goto counts', async () => {
    const nodes = [titled];
    const double = pageDouble(nodes);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    await tab.navigated();
    nodes.push(unnamed());
    tab.used();
    expect(await ended()).toContain('X_E2E_A11Y_VIOLATION');
  });

  test('a tab nobody called in this test is not read again', async () => {
    const double = pageDouble([titled]);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    tab.used();
    await ended();
    const before = double.reads();
    expect(await ended()).toBe('passed');
    expect(double.reads()).toBe(before);
  });

  test('a closed tab is not read, and what its navigation found is still told', async () => {
    const double = pageDouble([titled, unnamed()]);
    let open = true;
    const tab = auditTab(double.page, () => Promise.resolve(open));
    await tab.navigated();
    open = false;
    tab.used();
    expect(await ended()).toContain('X_E2E_A11Y_VIOLATION');
    expect(double.reads()).toBe(1);
  });

  test('a page an e2eTest runner claimed is the runner’s: never judged here, with or without its allow', async () => {
    const double = pageDouble([titled, unnamed()]);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    startA11yRun(double.page, [], new Set());
    await tab.navigated();
    tab.used();
    expect(await ended()).toBe('passed');
    expect(double.reads()).toBe(0);
    // The claim ends with the test: the next one audits the tab again.
    await tab.navigated();
    expect(await ended()).toContain('X_E2E_A11Y_VIOLATION');
  });

  test('one finding is told once per run, not by every test that sees the same page', async () => {
    const double = pageDouble([titled, unnamed()]);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    await tab.navigated();
    expect(await ended()).toContain('X_E2E_A11Y_VIOLATION');
    await tab.navigated();
    expect(await ended()).toBe('passed');
  });

  test('the fix names allowA11y — the raw tab’s place to say allow, not e2eTest’s options', async () => {
    const tab = auditTab(pageDouble([titled, unnamed()]).page, () => Promise.resolve(true));
    await tab.navigated();
    const error: unknown = await endTabA11y().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(E2eA11yViolationError);
    const { fix } = error as E2eA11yViolationError;
    expect(fix).toContain('allowA11y([{ role: "button"');
    expect(fix).not.toContain('e2eTest(');
  });

  test('allowA11y drops that role and selector for this test only; without a because it is refused', async () => {
    const double = pageDouble([titled, unnamed()]);
    const tab = auditTab(double.page, () => Promise.resolve(true));
    allowA11y([{ role: 'button', selector: '#b', because: 'fixture: the unnamed control' }]);
    await tab.navigated();
    expect(await ended()).toBe('passed');
    expect(() => allowA11y([{ role: 'button', selector: '#b', because: ' ' }])).toThrow(
      /X_E2E_A11Y_VIOLATION/,
    );
    await ended();
  });
});
