// Inline SVG from one Lucide glyph. Decorative by default (`aria-hidden`); a `label`
// promotes it to `role="img"` with a name. Paint is `currentColor` and the box is one
// `em`, so an icon takes the tone and the type step of whatever it sits inside.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Icon.module.scss';
import type { IconElement, IconGlyph } from './icon-glyph';
import { iconElements } from './icon-glyph';
import type { Size } from './variants';

/** Every Lucide glyph is drawn on this grid; the box is sized in CSS, never here. */
const VIEW_BOX = '0 0 24 24';

export interface IconProps {
  /** One glyph module: `import { iconSearch } from '@ultimat3/ui/icons/search'`. */
  glyph: IconGlyph;
  /**
   * Already-translated accessible name. Omitted means decorative, and a decorative icon is hidden
   * from assistive tech rather than read as a nameless image.
   */
  label?: string | undefined;
  size?: Size | undefined;
  class?: string | undefined;
}

export function Icon(props: IconProps): JSX.Element {
  return (
    <svg
      class={cx(styles['icon'], styles[`size-${props.size ?? 'md'}`], props.class)}
      viewBox={VIEW_BOX}
      role={props.label === undefined ? undefined : 'img'}
      aria-hidden={props.label === undefined ? 'true' : undefined}
      aria-label={props.label}
    >
      {iconElements(props.glyph).map((element) => glyphNode(element))}
    </svg>
  );
}

/**
 * One element per tag, written out. A `<Dynamic>` would need solid-js as a value import (this
 * package only ever types against it), and a spread would put unchecked keys on an attribute sink.
 */
function glyphNode(element: IconElement): JSX.Element {
  const attrs = element.attrs;
  switch (element.tag) {
    case 'circle':
      return <circle cx={attrs['cx']} cy={attrs['cy']} r={attrs['r']} fill={attrs['fill']} />;
    case 'ellipse':
      return <ellipse cx={attrs['cx']} cy={attrs['cy']} rx={attrs['rx']} ry={attrs['ry']} />;
    case 'line':
      return <line x1={attrs['x1']} x2={attrs['x2']} y1={attrs['y1']} y2={attrs['y2']} />;
    case 'path':
      return <path d={attrs['d']} />;
    case 'polygon':
      return <polygon points={attrs['points']} />;
    case 'polyline':
      return <polyline points={attrs['points']} />;
    case 'rect':
      return (
        <rect
          x={attrs['x']}
          y={attrs['y']}
          width={attrs['width']}
          height={attrs['height']}
          rx={attrs['rx']}
          ry={attrs['ry']}
        />
      );
  }
}
