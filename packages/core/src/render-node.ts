// The render node brands, the one literal of each in the framework. A leaf with no import,
// published at `@ultimat3/core/render-node` so `@ultimat3/render` stamps them and
// `@ultimat3/core/render-nodes` reads them without either joining the barrel. Registered on the
// GLOBAL symbol registry: two copies of a module must agree on a node.

/** An element or a component call: `{ [JSX_NODE]: true, type, props }`. */
export const JSX_NODE: unique symbol = Symbol.for('ultimate.render.jsx') as never;

/** An island: a branded ARRAY whose `props.children` is the server shell. */
export const ISLAND_NODE: unique symbol = Symbol.for('ultimate.render.island') as never;

/** A stream hole: a branded ARRAY whose first flush is `props.fallback` and `props.error`. */
export const HOLE_NODE: unique symbol = Symbol.for('ultimate.render.hole') as never;
