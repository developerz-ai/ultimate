// `<Hole>`: the marker that makes a subtree of a `stream` page arrive after the first flush. It
// decides nothing, it only names the three trees. `renderNode` calls a component with no view of
// the walk, so the walker in `render-html.ts` is what sees this node and picks what it means.

/** Registered globally so two copies of this module agree on what a hole node is. */
export const HOLE_NODE: unique symbol = Symbol.for('ultimate.render.hole') as never;

export interface HoleProps {
  /** Markup in the first flush, until the hole fills. Rendered at shell time. */
  readonly fallback: unknown;
  /** Replaces the fallback when `children` throw or miss the deadline. Rendered at shell time. */
  readonly error?: unknown;
  /** Awaited after the first flush. A thunk or an async child is what makes the wait start there. */
  readonly children?: unknown;
}

/**
 * Array-based for the reason `IslandNode` states: `ArrayElement` is the one object shape the
 * configured `JSX.Element` admits, so this is what lets `<Hole>` be an ordinary JSX component.
 */
export interface HoleNode extends Array<never> {
  readonly [HOLE_NODE]: true;
  readonly props: HoleProps;
}

/** Tested BEFORE `Array.isArray` by the walker: the array branch would render it as nothing. */
export function isHoleNode(value: unknown): value is HoleNode {
  return typeof value === 'object' && value !== null && HOLE_NODE in value;
}

export function Hole(props: HoleProps): HoleNode {
  return Object.assign([] as never[], { [HOLE_NODE]: true as const, props });
}
