// The heading element a composite renders, written out one intrinsic per level. `<Heading>` over
// `headingTag(level)` is a string to the server's JSX factory and a COMPONENT to the island
// build's Solid transform, which calls it and throws (#488, `intrinsic-root.test.ts`). PageHeader,
// Section and Accordion all render through this, so the switch exists once.

import type { JSX } from 'solid-js';
import type { HeadingTag } from './heading-level';

export interface HeadingNodeAttrs {
  readonly id?: string | undefined;
  readonly class?: string | undefined;
}

/**
 * `tag` comes from `headingTag(level)`, resolved once by the caller so an off-scale level still
 * throws `X_UI_INVALID_VALUE` there. `content` is an accessor: read inside the element, it stays
 * reactive in an island.
 */
export function headingNode(
  tag: HeadingTag,
  attrs: HeadingNodeAttrs,
  content: () => JSX.Element,
): JSX.Element {
  switch (tag) {
    case 'h1':
      return (
        <h1 id={attrs.id} class={attrs.class}>
          {content()}
        </h1>
      );
    case 'h2':
      return (
        <h2 id={attrs.id} class={attrs.class}>
          {content()}
        </h2>
      );
    case 'h3':
      return (
        <h3 id={attrs.id} class={attrs.class}>
          {content()}
        </h3>
      );
    case 'h4':
      return (
        <h4 id={attrs.id} class={attrs.class}>
          {content()}
        </h4>
      );
    case 'h5':
      return (
        <h5 id={attrs.id} class={attrs.class}>
          {content()}
        </h5>
      );
    case 'h6':
      return (
        <h6 id={attrs.id} class={attrs.class}>
          {content()}
        </h6>
      );
  }
}
