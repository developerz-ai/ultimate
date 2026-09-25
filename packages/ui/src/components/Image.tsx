// Zero-CLS image primitive: a plain <img>, or a <picture> around one when AVIF/WebP renditions
// are handed in. No JS, no fetch, no client state.
//
// The encoding half of the pipeline — AVIF/WebP renditions, measured dimensions — is the app's
// build step; the URLs come from `asset('assets/…')` in the page. This component emits exactly
// what it is handed and fabricates nothing, except the one thing it insists on: a reserved box.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Image.module.scss';
import {
  assertNonEmptySrc,
  boxFor,
  type ImageAspectRatio,
  type ImageBox,
  type ImageLoadingHints,
  type ImageSourceSet,
  type ImageSources,
  type ImageVariant,
  loadingHints,
  reservedRatio,
  sourceSetsFor,
  srcsetFor,
} from './image-source';

/**
 * The box is ALWAYS reserved: the intrinsic size, or an explicit ratio when the size is not known
 * (a CSS-sized hero). Neither is a type error here and `X_UI_INVALID_VALUE` at render.
 */
export type ImageDimensions =
  | { width: number; height: number; aspectRatio?: undefined }
  | { aspectRatio: ImageAspectRatio; width?: undefined; height?: undefined };

export interface ImageBaseProps {
  /** The fallback every browser can decode — usually the JPEG/PNG rendition. */
  src: string;
  /**
   * Required, with no default: an <Image> whose meaning is undescribed is a type
   * error at the call site. Pass `alt=""` for a decorative image, deliberately.
   */
  alt: string;
  /** Renditions of `src`'s own encoding; the descriptors and their order are derived. */
  variants?: readonly ImageVariant[] | undefined;
  /** AVIF and WebP renditions, each a width list: `{ avif: [{ src: asset('…'), width: 640 }] }`. */
  sources?: ImageSources | undefined;
  /** Layout width of the box, e.g. `(max-width: 700px) 100vw, 620px`. Applies to every set. */
  sizes?: string | undefined;
  /** The LCP image, at most one per route: eager, `fetchpriority="high"`, never lazy. */
  priority?: boolean | undefined;
  /** Intrinsic size in CSS pixels, from the step that encoded it. Both, or `aspectRatio`. */
  width?: number | undefined;
  height?: number | undefined;
  /** `'16 / 9'` — the reservation when the intrinsic size is not known. Never beside width/height. */
  aspectRatio?: ImageAspectRatio | undefined;
  class?: string | undefined;
}

/** What a call site passes: the base props, with exactly one of the two box forms required. */
export type ImageProps = ImageBaseProps & ImageDimensions;

export function Image(props: ImageBaseProps & ImageDimensions): JSX.Element {
  const src = (): string => assertNonEmptySrc('Image', props.src, props.src);
  const hints = (): ImageLoadingHints => loadingHints(props.priority);
  // Validated first: `reservedRatio` refuses a missing box before anything is emitted.
  const ratio = (): string => reservedRatio(props.width, props.height, props.aspectRatio);
  const box = (): ImageBox | undefined => boxFor(props.width, props.height);
  const sets = (): readonly ImageSourceSet[] => sourceSetsFor(props.sources);
  // Once, eagerly: a compiled `style` binding may be read inside an effect, and a refusal thrown
  // there reaches no caller. Here it fails the render that wrote the bad props.
  ratio();

  const img = (): JSX.Element => (
    <img
      class={cx(styles['image'], props.class)}
      // A custom property, because that is the one thing an inline `style` may carry here. The
      // stylesheet turns it into `aspect-ratio`, the half of the reservation that survives styling.
      style={{ '--image-ratio': ratio() }}
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

  if (sets().length === 0) return img();
  return (
    <picture class={styles['picture']}>
      {sets().map((set) => (
        <source type={set.type} srcset={set.srcset} sizes={props.sizes} />
      ))}
      {img()}
    </picture>
  );
}
