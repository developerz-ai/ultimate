// Identity chip. An avatar image always carries intrinsic dimensions and an
// empty alt (the name is rendered as text or the accessible label), so it can
// never shift layout or duplicate the name to a screen reader.

import { safeUrl } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Avatar.module.scss';
import type { Size } from './variants';

export interface AvatarProps {
  /** Already-localised display name. Drives initials and the accessible name. */
  name: string;
  src?: string | undefined;
  size?: Size | 'xs' | 'xl' | undefined;
  shape?: 'circle' | 'rounded' | undefined;
  /** Presence ring; the meaning must also be conveyed in text nearby. */
  status?: 'online' | 'busy' | 'offline' | undefined;
  class?: string | undefined;
}

const PX: Readonly<Record<string, number>> = { xs: 20, sm: 24, md: 32, lg: 40, xl: 64 };

/** First letters of the first two words — locale-safe, no ASCII assumptions. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

export function Avatar(props: AvatarProps): JSX.Element {
  const px = (): number => PX[props.size ?? 'md'] ?? 32;

  return (
    <span
      class={cx(
        styles['avatar'],
        styles[`shape-${props.shape ?? 'circle'}`],
        props.status === undefined ? undefined : styles[`status-${props.status}`],
        props.class,
      )}
      style={{ '--avatar-size': `${px()}px` }}
      title={props.name}
    >
      {props.src === undefined ? (
        <span aria-hidden="true" class={styles['initials']}>
          {initialsOf(props.name)}
        </span>
      ) : (
        <img
          src={safeUrl(props.src, 'src') ?? undefined}
          alt=""
          width={px()}
          height={px()}
          loading="lazy"
          decoding="async"
        />
      )}
      <span class={styles['name']}>{props.name}</span>
    </span>
  );
}
