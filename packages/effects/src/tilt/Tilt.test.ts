// The component's handlers, reached through its rendered node, over a fake page.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nodesOf } from '@ultimat3/core/render-nodes';
import { type FakePage, installFakePage } from '../mount-harness-fixture';
import { Tilt } from './Tilt';

let page: FakePage | undefined;
beforeEach(() => {
  page = installFakePage();
});
afterEach(() => page?.restore());

const target = () => {
  const props = new Map<string, string>();
  return {
    props,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    style: {
      setProperty: (n: string, v: string) => void props.set(n, v),
      removeProperty: (n: string) => void props.delete(n),
    },
  };
};

describe('Tilt', () => {
  const [node] = nodesOf(Tilt({ maxAngle: 10 }));
  if (node === undefined) expect.unreachable('Tilt rendered no node');

  test('leans on a mouse move and lies flat on leave', () => {
    const currentTarget = target();
    (node.props['onPointerMove'] as (e: unknown) => void)({
      currentTarget,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 0,
    });
    expect(currentTarget.props.get('--tilt-y')).toBe('10deg');
    (node.props['onPointerLeave'] as (e: unknown) => void)({ currentTarget });
    expect(currentTarget.props.size).toBe(0);
  });

  test('an invalid angle is refused when the component is built', () => {
    expect(() => Tilt({ maxAngle: -1 })).toThrow();
  });
});
