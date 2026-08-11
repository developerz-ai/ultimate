// One titled list of relationships. Five sections on the friends screen share this component, so
// "a person, a date, a status and maybe one control" is decided once instead of five times.
//
// There is no icon set in this framework, so every affordance here is a text label. `EmptyState`
// from @ultimat3/ui is deliberately NOT used: it reads the Solid context through `useUi()`, and the
// pinned solid-js@2.0.0-experimental.16 registers no server runtime, so rendering one throws
// X_UI_RUNTIME_MISSING. A `Text` in the same slot says the same thing and survives SSR.

import { t } from '@ultimat3/i18n';
import type { Tone } from '@ultimat3/ui';
import { Avatar, Badge, Card, Link, Section, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { EdgeView } from '../screen';
import { day } from './day';
import styles from './edge-list.module.scss';

export interface EdgeListProps {
  /** Already-translated. Every string on this component arrives translated; none is built here. */
  readonly title: string;
  readonly description: string;
  readonly empty: string;
  readonly items: readonly EdgeView[];
  /** The catalog key whose `{date}` slot this list's date fills — "asked", "answered", "blocked". */
  readonly dateKey: string;
  readonly badge?: { readonly label: string; readonly tone: Tone } | undefined;
  /** Rendered per row when the viewer may act on it. Absent means this list is read-only. */
  readonly control?: ((item: EdgeView) => JSX.Element) | undefined;
}

export function EdgeList(props: EdgeListProps): JSX.Element {
  return (
    <Section title={props.title} description={props.description}>
      {props.items.length === 0 ? (
        <Text as="p" tone="muted">
          {props.empty}
        </Text>
      ) : (
        <Stack as="ul" gap={3} class={styles.list}>
          {props.items.map((item) => (
            <Card as="li" padding={4}>
              <Stack direction="row" gap={3} align="center" justify="between" wrap>
                <Stack direction="row" gap={3} align="center">
                  <Avatar name={item.person.displayName} size="md" />
                  <Stack gap={1}>
                    <Link href={`/u/${item.person.handle}`}>{item.person.displayName}</Link>
                    <Text size="sm" tone="muted">
                      @{item.person.handle} · {t(props.dateKey, { date: day(item.at) })}
                    </Text>
                  </Stack>
                </Stack>
                <Stack direction="row" gap={3} align="center">
                  {props.badge === undefined ? null : (
                    <Badge tone={props.badge.tone}>{props.badge.label}</Badge>
                  )}
                  {props.control === undefined ? null : props.control(item)}
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Section>
  );
}
