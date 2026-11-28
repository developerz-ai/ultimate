// The component's handlers, reached through its rendered node: what an island's events call.

import { describe, expect, test } from 'bun:test';
import { nodesOf } from '@ultimat3/core/render-nodes';
import { SpotlightCard } from './SpotlightCard';

const card = () => {
  const props = new Map<string, string>();
  return {
    props,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    style: { setProperty: (n: string, v: string) => void props.set(n, v) },
  };
};

const root = () => {
  const [node] = nodesOf(SpotlightCard({}));
  if (node === undefined) expect.unreachable('SpotlightCard rendered no node');
  return node;
};

describe('SpotlightCard', () => {
  test('is labelled with its backend', () => {
    expect(root().props['data-effect-backend']).toBe('static');
  });

  test('a pointer move aims the highlight', () => {
    const currentTarget = card();
    (root().props['onPointerMove'] as (e: unknown) => void)({
      currentTarget,
      clientX: 150,
      clientY: 80,
    });
    expect(Object.fromEntries(currentTarget.props)).toEqual({
      '--spot-x': '50px',
      '--spot-y': '30px',
    });
  });

  test('a focus-in from a keyboard-focused element aims; a non-element target is ignored', () => {
    const onFocusIn = root().props['onFocusIn'] as (e: unknown) => void;
    const scope = globalThis as { HTMLElement?: unknown };
    const saved = scope.HTMLElement;
    class FakeElement {
      matches = () => true;
      getBoundingClientRect = () => ({ left: 120, top: 60, width: 40, height: 20 });
    }
    scope.HTMLElement = FakeElement;
    try {
      const currentTarget = card();
      onFocusIn({ currentTarget, target: new FakeElement() });
      expect(currentTarget.props.get('--spot-x')).toBe('40px');
      const ignored = card();
      onFocusIn({ currentTarget: ignored, target: {} });
      expect(ignored.props.size).toBe(0);
    } finally {
      scope.HTMLElement = saved;
    }
  });
});
