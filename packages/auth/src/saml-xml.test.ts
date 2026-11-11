// The strict reader: what it keeps (namespaces, comments as nodes, normalised text) and every
// construct it refuses, each with the reason it is refused for.

import { describe, expect, test } from 'bun:test';
import { textOf } from './saml-dom';
import { MAX_NAMESPACE_DECLARATIONS, MAX_XML_LENGTH, parseXml, type XmlElement } from './saml-xml';

const root = (xml: string): XmlElement => {
  const parsed = parseXml(xml);
  return parsed.ok ? parsed.root : expect.unreachable(parsed.reason);
};
const refused = (xml: string): boolean => !parseXml(xml).ok;

describe('parseXml keeps', () => {
  test('namespaces resolved per element and attribute, inherited through scope', () => {
    const r = root('<a:r xmlns:a="urn:a" xmlns="urn:d"><x a:k="1" k="2"/></a:r>');
    const x = r.children[0];
    if (x?.kind !== 'element') return expect.unreachable('no child');
    expect([r.ns, x.ns]).toEqual(['urn:a', 'urn:d']);
    expect(x.attributes.map((a) => [a.ns, a.local])).toEqual([
      ['urn:a', 'k'],
      ['', 'k'],
    ]);
  });

  test('comments as nodes, so text around one is two halves of one value', () => {
    expect(textOf(root('<r>ada@corp<!-- x -->.evil</r>'))).toBe('ada@corp.evil');
  });

  test('CRLF normalised, references decoded, attribute white space normalised', () => {
    const r = root('<r a="x\ty&#9;z">1\r\n2&amp;&#x41;<![CDATA[<b>]]></r>');
    expect(r.attributes[0]?.value).toBe('x y\tz');
    expect(textOf(r)).toBe('1\n2&A<b>');
  });

  test('an XML declaration and surrounding comments', () => {
    expect(root('<?xml version="1.0" encoding="UTF-8"?><!-- c --><r/><!-- c -->').local).toBe('r');
  });
});

describe('parseXml refuses', () => {
  const cases = [
    ['a DOCTYPE inside content', '<r><!DOCTYPE x></r>'],
    ['a processing instruction inside content', '<r><?pi x?></r>'],
    ['an unknown entity', '<r>&nbsp;</r>'],
    ['a bare ampersand', '<r>a & b</r>'],
    ['a reference to no XML character', '<r>&#0;</r>'],
    ['a raw control character', '<r>\u0001</r>'],
    ['one attribute twice', '<r a="1" a="2"/>'],
    ['one expanded attribute name twice', '<r xmlns:p="urn:x" xmlns:q="urn:x" p:a="1" q:a="2"/>'],
    ['a comment carrying --', '<r><!-- a -- b --></r>'],
    ['a mismatched end tag', '<r></s>'],
    ['an undeclared prefix', '<p:r/>'],
    ['an undeclared prefix binding', '<r xmlns:p=""/>'],
    ['content after the root', '<r/>x'],
    ['< inside an attribute value', '<r a="<"/>'],
    ['nesting deeper than any SAML message', `${'<r>'.repeat(80)}${'</r>'.repeat(80)}`],
    ['a document past the size bound', `<r>${'x'.repeat(MAX_XML_LENGTH)}</r>`],
  ] as const;
  for (const [name, xml] of cases) {
    test(name, () => expect(refused(xml)).toBe(true));
  }
});

describe('parseXml bounds namespace work', () => {
  // 8,000 prefixes on the root and 8,000 children each declaring one more: a copied scope per
  // element made this 5 GB of RSS through the ACS route, before any signature was looked at.
  // What bounds it is WHERE the refusal lands, so that is what is pinned — never elapsed time.
  test('K declarations over N elements is refused at the bound, before the children are read', () => {
    const declarations = Array.from({ length: 8000 }, (_, i) => ` xmlns:p${i}="u"`).join('');
    // No closing tag: a refusal deferred past the children would name the unclosed root instead.
    const xml = `<r${declarations}>${'<a xmlns:b="u"/>'.repeat(8000)}`;
    const parsed = parseXml(xml);
    expect(parsed.ok ? 'accepted' : parsed.reason).toContain('namespace declarations');
  });

  test('the bound counts the whole document: one declaration on each of many elements', () => {
    const children = (n: number): string => '<a xmlns:b="u"/>'.repeat(n);
    expect(refused(`<r xmlns:p="u">${children(MAX_NAMESPACE_DECLARATIONS - 1)}</r>`)).toBe(false);
    const over = parseXml(`<r xmlns:p="u">${children(MAX_NAMESPACE_DECLARATIONS)}</r>`);
    expect(over.ok ? 'accepted' : over.reason).toContain('namespace declarations');
  });

  test('an element that declares nothing shares its parent scope, never a copy of it', () => {
    const r = root('<r xmlns:p="urn:p"><a/><b xmlns:q="urn:q"/></r>');
    const [a, b] = r.children;
    if (a?.kind !== 'element' || b?.kind !== 'element') return expect.unreachable('no children');
    expect(a.scope).toBe(r.scope);
    expect(b.scope).not.toBe(r.scope);
    expect([b.scope.get('p'), b.scope.get('q'), r.scope.get('q')]).toEqual([
      'urn:p',
      'urn:q',
      undefined,
    ]);
  });

  test(`up to ${MAX_NAMESPACE_DECLARATIONS} declarations in a document are read`, () => {
    const declarations = Array.from(
      { length: MAX_NAMESPACE_DECLARATIONS },
      (_, i) => ` xmlns:p${i}="urn:${i}"`,
    );
    const r = root(`<r${declarations.join('')}><p7:x/></r>`);
    const x = r.children[0];
    expect(x?.kind === 'element' ? x.ns : '').toBe('urn:7');
  });

  test('one prefix declared twice on one element is refused, not last-one-wins', () => {
    expect(refused('<p:a xmlns:p="urn:one" xmlns:p="urn:two"/>')).toBe(true);
    expect(refused('<a xmlns="urn:one" xmlns="urn:two"/>')).toBe(true);
  });
});
