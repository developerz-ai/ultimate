// The audit's rules against a tree a browser really answered (`e2e-a11y-tree-fixture.ts`): every
// unnamed row in the plan's table is flagged, the named twins and what the browser pruned pass,
// and the role spellings are pinned to the browser's — `image`, never `img`.

import { describe, expect, test } from 'bun:test';
import type { AxTreeNode } from './ax-node';
import { toAxTreeNodes } from './ax-node';
import type { A11yFinding } from './e2e-a11y';
import {
  auditTree,
  DOCUMENT_ROLE,
  FOCUSABLE_ROLE,
  findingKey,
  HTML_BOUND,
  NAMED_ROLES,
  probeFindings,
  ruleFor,
  treeFinding,
} from './e2e-a11y';
import { RECORDED_TREE } from './e2e-a11y-tree-fixture';

const tree = toAxTreeNodes(RECORDED_TREE);

const node = (over: Partial<AxTreeNode>): AxTreeNode => ({
  role: 'button',
  roleType: 'role',
  name: '',
  ignored: false,
  ...over,
});

describe('auditTree over the recorded tree', () => {
  test('flags every unnamed row of the table, the document included, in the browser’s order', () => {
    expect(auditTree(tree).map((n) => `${n.roleType}:${n.role}`)).toEqual([
      'internalRole:RootWebArea',
      'role:button',
      'role:link',
      'role:textbox',
      'role:searchbox',
      'role:combobox',
      'role:textbox',
      'role:checkbox',
      'role:radio',
      'role:switch',
      'role:slider',
      'role:spinbutton',
      'role:tab',
      'role:menuitem',
      'role:image',
      'role:image',
      'role:heading',
      'internalRole:Iframe',
      'internalRole:DisclosureTriangle',
    ]);
  });

  test('the named twins pass: one button, one link, one heading each carry a name', () => {
    const named = tree.filter((n) => !n.ignored && n.name !== '').map((n) => n.role);
    expect(named).toEqual(expect.arrayContaining(['button', 'link', 'heading']));
    expect(auditTree(tree).every((n) => n.name.trim() === '')).toBe(true);
  });

  test('alt="" and an aria-hidden subtree are pruned by the browser, so no rule is needed', () => {
    // Two `<img>` on the page and one `<svg role=img>`: only the unnamed `<img>` and the svg are
    // in the tree. The decorative one never entered it; neither did the hidden button's name.
    expect(tree.filter((n) => !n.ignored && n.role === 'image')).toHaveLength(2);
    expect(tree.some((n) => !n.ignored && n.name === 'hidden')).toBe(false);
  });

  test('the table spells an image the browser’s way — `img` would match nothing it says', () => {
    expect(NAMED_ROLES.role).toContain('image');
    expect(NAMED_ROLES.role).not.toContain('img');
    expect(tree.some((n) => n.role === 'img')).toBe(false);
  });
});

describe('ruleFor', () => {
  test('keys on the role TYPE: an author’s role="Iframe" is not the browser’s Iframe', () => {
    expect(ruleFor(node({ role: 'Iframe', roleType: 'internalRole' }))).toBe('name');
    expect(ruleFor(node({ role: 'Iframe', roleType: 'role' }))).toBeUndefined();
    expect(ruleFor(node({ role: 'button', roleType: 'internalRole' }))).toBeUndefined();
  });

  test('the document with no name is the title rule; a blank name counts as none', () => {
    expect(ruleFor(node({ role: DOCUMENT_ROLE, roleType: 'internalRole' }))).toBe('title');
    expect(ruleFor(node({ name: '   ' }))).toBe('name');
  });

  test('an ignored node or a named one breaks nothing; a role outside the table neither', () => {
    expect(ruleFor(node({ ignored: true }))).toBeUndefined();
    expect(ruleFor(node({ name: 'Save' }))).toBeUndefined();
    expect(ruleFor(node({ role: 'generic' }))).toBeUndefined();
  });
});

describe('probeFindings', () => {
  const url = 'http://app.test/feed';

  test('no lang is a finding on the document; every hidden focusable is one each', () => {
    const answer = JSON.stringify({
      lang: false,
      root: { html: '<html>', matches: ['html'] },
      hidden: [
        { html: '<button>x</button>', matches: [] },
        { html: '<a href="/">', matches: [] },
      ],
    });
    expect(probeFindings(answer, url)).toEqual([
      { rule: 'lang', role: DOCUMENT_ROLE, url, html: '<html>', matches: ['html'] },
      {
        rule: 'aria-hidden-focus',
        role: FOCUSABLE_ROLE,
        url,
        html: '<button>x</button>',
        matches: [],
      },
      { rule: 'aria-hidden-focus', role: FOCUSABLE_ROLE, url, html: '<a href="/">', matches: [] },
    ]);
  });

  test('a page with a lang and nothing hidden finds nothing; a foreign answer finds nothing', () => {
    expect(probeFindings(JSON.stringify({ lang: true, root: {}, hidden: [] }), url)).toEqual([]);
    expect(probeFindings(null, url)).toEqual([]);
    expect(probeFindings(JSON.stringify(3), url)).toEqual([]);
  });

  test('a document that is not markup is no page to audit: undefined, not an empty list', () => {
    const json = JSON.stringify({ html: false, lang: false, root: {}, hidden: [] });
    expect(probeFindings(json, url)).toBeUndefined();
  });

  test('markup is bounded even when the page answered more, and junk matches are dropped', () => {
    const answer = { lang: false, root: { html: 'x'.repeat(500), matches: ['a', 7] }, hidden: [] };
    const found = probeFindings(answer, url);
    if (found === undefined) return expect.unreachable('an HTML answer was read as no document');
    const [lang] = found;
    expect(lang?.html).toHaveLength(HTML_BOUND);
    expect(lang?.matches).toEqual(['a']);
  });
});

describe('a finding', () => {
  test('a tree node becomes its rule, role, bounded markup and the url', () => {
    expect(treeFinding(node({ html: '<button></button>', matches: ['#x'] }), 'http://a/')).toEqual({
      rule: 'name',
      role: 'button',
      html: '<button></button>',
      url: 'http://a/',
      matches: ['#x'],
    });
  });

  test('is deduplicated on rule, role, markup and url — and on nothing else', () => {
    const base: A11yFinding = { rule: 'name', role: 'link', html: '<a>', url: 'u', matches: [] };
    expect(findingKey({ ...base, matches: ['x'] })).toBe(findingKey(base));
    for (const changed of [
      { rule: 'title' as const },
      { role: 'button' },
      { html: '<b>' },
      { url: 'v' },
    ]) {
      expect(findingKey({ ...base, ...changed })).not.toBe(findingKey(base));
    }
  });
});
