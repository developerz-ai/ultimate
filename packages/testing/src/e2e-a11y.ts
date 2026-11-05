// The accessibility audit's RULES: which of the browser's own tree nodes a screen reader cannot
// name, the one in-page probe for what the tree prunes (`<html lang>`, focus under `aria-hidden`),
// and how a finding is told. No engine and no heuristics: every rule is a fact the browser already
// computed. When it runs and how it fails a test is `e2e-a11y-run.ts`.

import type { AxTreeNode } from './ax-node';

/**
 * Roles whose node needs a non-blank name, keyed on the browser's spelling AND its `role.type`
 * (probed on Chrome, 2026-11-02): an ARIA `role` and Chrome's `internalRole` never share a key,
 * so an author's `role="Iframe"` is not the browser's `Iframe`. An image is `image`, never `img`.
 */
export const NAMED_ROLES: Readonly<Record<'role' | 'internalRole', readonly string[]>> = {
  role: [
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'spinbutton',
    'tab',
    'menuitem',
    'image',
    'heading',
  ],
  internalRole: ['Iframe', 'DisclosureTriangle'],
};

/** The document itself: an empty name is a page with no `<title>`. */
export const DOCUMENT_ROLE = 'RootWebArea';

/** What a probe finding under `aria-hidden` is called: the tree pruned it, so it has no role. */
export const FOCUSABLE_ROLE = 'focusable';

export type A11yRule = 'name' | 'title' | 'lang' | 'aria-hidden-focus';

/** One element that fails, as the error tells it and as an `allow` entry matches it. */
export interface A11yFinding {
  readonly rule: A11yRule;
  readonly role: string;
  /** `outerHTML`, at most `HTML_BOUND` characters. */
  readonly html: string;
  readonly url: string;
  /** The `allow` selectors this element matches — read in the page, never re-derived here. */
  readonly matches: readonly string[];
}

/** A finding is read by a person in a terminal: the opening tag is what names the element. */
export const HTML_BOUND = 120;

const blank = (text: string): boolean => text.trim() === '';

/** The rule a tree node breaks, or undefined. Only an UNIGNORED node is in the reader's tree. */
export const ruleFor = (node: AxTreeNode): A11yRule | undefined => {
  if (node.ignored || !blank(node.name)) return undefined;
  if (node.roleType === 'internalRole' && node.role === DOCUMENT_ROLE) return 'title';
  const named =
    node.roleType === 'role'
      ? NAMED_ROLES.role
      : node.roleType === 'internalRole'
        ? NAMED_ROLES.internalRole
        : [];
  return named.includes(node.role) ? 'name' : undefined;
};

/** Every node of a tree that breaks a rule, in the browser's order. */
export const auditTree = (nodes: readonly AxTreeNode[]): readonly AxTreeNode[] =>
  nodes.filter((node) => ruleFor(node) !== undefined);

/**
 * What the tree cannot say, asked in ONE evaluate. Answers JSON text. Focusable means reachable by
 * Tab: rendered, not disabled, not `inert`, not `tabindex="-1"`.
 */
export const probeExpression = (selectors: readonly string[]): string => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const describe = (el) => ({
    html: (el === document.documentElement
      ? el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1)
      : el.outerHTML).slice(0, ${String(HTML_BOUND)}),
    matches: selectors.filter((s) => { try { return el.matches(s); } catch { return false; } }),
  });
  const root = document.documentElement;
  const focusable = 'a[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  const hidden = [...document.querySelectorAll('[aria-hidden="true"]')]
    .flatMap((host) => [host, ...host.querySelectorAll(focusable)])
    .filter((el, at, all) => all.indexOf(el) === at && el.matches(focusable))
    .filter((el) => !el.matches(':disabled') && el.getAttribute('tabindex') !== '-1')
    .filter((el) => el.closest('[inert]') === null && el.getClientRects().length > 0)
    .map(describe);
  return JSON.stringify({
    html: document.contentType === 'text/html' || document.contentType === 'application/xhtml+xml',
    lang: (root?.getAttribute('lang') ?? '').trim() !== '',
    root: root === null ? { html: '', matches: [] } : describe(root),
    hidden,
  });
})()`;

interface Described {
  readonly html: string;
  readonly matches: readonly string[];
}

const described = (raw: unknown): Described => {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const html = value['html'];
  const matches = value['matches'];
  return {
    html: typeof html === 'string' ? html.slice(0, HTML_BOUND) : '',
    matches: Array.isArray(matches)
      ? matches.filter((m): m is string => typeof m === 'string')
      : [],
  };
};

/**
 * The probe's answer as findings. `undefined` is a document that is not markup — JSON, an image,
 * a PDF the browser wrapped in its own viewer — which no rule here is about. An answer that is not
 * the probe's shape finds nothing.
 */
export const probeFindings = (raw: unknown, url: string): readonly A11yFinding[] | undefined => {
  const decoded: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof decoded !== 'object' || decoded === null) return [];
  const answer = decoded as Record<string, unknown>;
  if (answer['html'] === false) return undefined;
  const hidden = Array.isArray(answer['hidden']) ? answer['hidden'] : [];
  const out: A11yFinding[] = hidden.map((el) => ({
    rule: 'aria-hidden-focus',
    role: FOCUSABLE_ROLE,
    url,
    ...described(el),
  }));
  if (answer['lang'] === false) {
    out.unshift({ rule: 'lang', role: DOCUMENT_ROLE, url, ...described(answer['root']) });
  }
  return out;
};

/** A tree node that broke a rule, as a finding. */
export const treeFinding = (node: AxTreeNode, url: string): A11yFinding => ({
  rule: ruleFor(node) ?? 'name',
  role: node.role,
  html: (node.html ?? '').slice(0, HTML_BOUND),
  url,
  matches: node.matches ?? [],
});

/** The four facts a finding is deduplicated on: a shared header reports once per URL. */
export const findingKey = (finding: A11yFinding): string =>
  JSON.stringify([finding.rule, finding.role, finding.html, finding.url]);
