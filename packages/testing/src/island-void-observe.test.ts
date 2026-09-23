// Two fidelity gaps in the micro-DOM an island test mounts into: the HTML void elements the parser
// treats as leaves, and an observer re-attached after `disconnect()`.

import { describe, expect, test } from 'bun:test';
import type { FakeElement } from './island-dom';
import { parseHtml } from './island-dom';
import { createResizeObservers, deliverResize, type SizedElement } from './island-observers';
import { testName } from './test-types';

const tagsUnder = (node: { readonly childNodes: readonly unknown[] }): string[] =>
  node.childNodes.map((child) => String((child as FakeElement).tagName ?? '#text').toLowerCase());

describe(testName('unit', 'every HTML void element is a leaf'), () => {
  // `VOID_TAGS` held six of the fourteen, so `<picture><source><img></picture>` parsed the img
  // INSIDE the source — a tree no browser builds, and one an island's querySelector disagrees with.
  test('<picture><source><img> keeps source and img as siblings', () => {
    const [picture] = parseHtml('<picture><source srcset="a.webp"><img src="a.png"></picture>')
      .childNodes as FakeElement[];
    expect(tagsUnder(picture as FakeElement)).toEqual(['source', 'img']);
  });

  for (const tag of ['area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']) {
    test(`<${tag}> takes no children`, () => {
      const root = parseHtml(`<div><${tag}><span></span></div>`);
      const [div] = root.childNodes as FakeElement[];
      expect(tagsUnder(div as FakeElement)).toEqual([tag, 'span']);
    });
  }
});

describe(testName('unit', 'an observer re-attached after disconnect()'), () => {
  // `disconnect()` takes the observer out of the registry, and `observe()` never put it back — so
  // an island that disconnects on one effect and re-observes on the next never heard a resize.
  test('receives the next resize', () => {
    const { registry, ResizeObserver } = createResizeObservers<SizedElement>();
    const target: SizedElement = {
      clientWidth: 0,
      clientHeight: 0,
      offsetWidth: 0,
      offsetHeight: 0,
    };
    const seen: number[] = [];
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) seen.push(entry.contentRect.width);
    });
    observer.observe(target);
    observer.disconnect();
    observer.observe(target);
    expect(deliverResize(registry, target, { width: 120 })).toBe(true);
    expect(seen).toEqual([120]);
  });
});
