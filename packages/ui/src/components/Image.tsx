// Zero-CLS image primitive: a plain <img>, no JS, no fetch, no client state.
//
// The build-time half of the pipeline in `docs/idea/07-rendering-seo.md` — reading
// real dimensions, encoding AVIF/WebP renditions, the data-URI blur placeholder —
// is NOT here. This component emits exactly what it is handed and fabricates
// nothing: no variants it was not given, no dimensions it did not measure.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Image.module.scss';
import {
  assertNonEmptySrc,
  boxFor,
  type ImageBox,
  type ImageLoadingHints,
  type ImageVariant,
  loadingHints,
  srcsetFor,
} from './image-source';

export interface ImageProps {
  src: string;
  /**
   * Required, with no default: an <Image> whose meaning is undescribed is a type
   * error at the call site. Pass `alt=""` for a decorative image, deliberately.
   */
  alt: string;
  /** Renditions to offer; the descriptors and their order are derived, not written. */
  variants?: readonly ImageVariant[] | undefined;
  /** Layout width of the box, e.g. `(max-width: 700px) 100vw, 620px`. */
  sizes?: string | undefined;
  /** The LCP image, at most one per route: eager, high fetch priority. */
  priority?: boolean | undefined;
  /** Intrinsic dimensions, from the build step that measured them. Both or neither. */
  width?: number | undefined;
  height?: number | undefined;
  class?: string | undefined;
}

export function Image(props: ImageProps): JSX.Element {
  const src = (): string => assertNonEmptySrc('Image', props.src, props.src);
  const hints = (): ImageLoadingHints => loadingHints(props.priority);
  const box = (): ImageBox | undefined => boxFor(props.width, props.height);

  return (
    <img
      class={cx(styles['image'], props.class)}
      src={src()}
      alt={props.alt}
      srcset={srcsetFor(props.variants)}
      sizes={props.sizes}
      width={box()?.width}
      height={box()?.height}
      loading={hints().loading}
      fetchpriority={hints().fetchpriority}
      decoding={hints().decoding}
    />
  );
}
