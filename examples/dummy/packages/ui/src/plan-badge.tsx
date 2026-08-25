/**
 * Plan name plus its monthly price. The price arrives as `Money` and is formatted exactly once,
 * here, by `<Money>` — every other layer moves integers around.
 */

import type { PlanCode } from '@postly/domain';
import { useT } from '@postly/i18n';
import type { Money as MoneyValue } from '@ultimat3/money';
import { Badge, Money, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import styles from './plan-badge.module.scss';

export type PlanBadgeProps = {
  readonly plan: PlanCode;
  readonly price: MoneyValue;
  readonly seats: number;
  /** Renders the plan's one-line pitch under the price. Off in compact contexts like the nav. */
  readonly withDescription?: boolean;
};

export const PlanBadge = (props: PlanBadgeProps): JSX.Element => {
  const t = useT();

  return (
    <Stack gap={1} class={styles.badge}>
      <div class={styles.headline}>
        <Badge tone={props.plan === 'free' ? 'neutral' : 'accent'}>
          {t(`plans.${props.plan}.name`)}
        </Badge>
        <span class={styles.price}>
          <Money value={props.price} />
        </span>
        <span class={styles.period}>{t('site.pricing.perMonth')}</span>
      </div>

      <Text tone="muted">{t('site.pricing.seats', { count: props.seats })}</Text>

      <Show when={props.withDescription}>
        <Text tone="muted">{t(`plans.${props.plan}.description`)}</Text>
      </Show>
    </Stack>
  );
};
