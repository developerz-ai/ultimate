// The `/admin` home's top band: one figure tile per resource the actor may open, each a link into
// the list it counts, and the same figures as a ring of shares. Server markup only — the admin
// ships no script — and a pure function of the counts it is handed.

import { currentLocale, t } from '@ultimat3/i18n';
import { Card, DonutChart, StatTile } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './screen-home.module.scss';
import type { ResourceCount } from './screen-home-counts';

export interface HomeKpisProps {
  readonly basePath: string;
  readonly counts: readonly ResourceCount[];
}

/** `data-stat` for a resource's tile: the stable hook a test or a live check reads it through. */
export const countStat = (entity: string): string => `admin-count-${entity}`;

export function HomeKpis(props: HomeKpisProps): JSX.Element {
  // The figure follows the page's locale: `Intl.NumberFormat` needs no time zone.
  const count = new Intl.NumberFormat(currentLocale());
  // Largest first, so the ring reads clockwise from the biggest share and the legend agrees. An
  // empty table is no share of anything: its tile says 0, and a legend of "0 · 0%" rows is noise.
  const ranked = props.counts
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);
  return (
    <section class={styles['band']} aria-labelledby="admin-home-records">
      <h2 id="admin-home-records" class={styles['heading']}>
        {t('admin.dashboard.records.title')}
      </h2>
      <ul class={styles['kpis']}>
        {props.counts.map(({ resource, count: total }) => (
          <li>
            <a class={styles['kpi']} href={`${props.basePath}${resource.path}`}>
              <StatTile
                label={t(resource.titleKey)}
                value={count.format(total)}
                stat={countStat(resource.name)}
              />
            </a>
          </li>
        ))}
      </ul>
      {/* One non-empty resource is a whole with one part: a ring of 100% says nothing new. */}
      {ranked.length < 2 ? null : (
        <Card class={styles['share']}>
          <DonutChart
            label={t('admin.dashboard.records.label')}
            showCaption
            segments={ranked.map(({ resource, count: total }) => ({
              label: t(resource.titleKey),
              value: total,
            }))}
            centreLabel={t('admin.dashboard.records.total')}
            keyLabel={t('admin.dashboard.records.resource')}
            valueLabel={t('admin.dashboard.records.title')}
            format={(value: number) => count.format(value)}
          />
        </Card>
      )}
    </section>
  );
}
