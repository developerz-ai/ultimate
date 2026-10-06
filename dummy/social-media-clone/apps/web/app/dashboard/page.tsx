// The authed dashboard: the viewer's own figures, their friendships by state, the activity on the
// posts they can see, and the four screens it exists to point at.
//
// The numbers come from `screen.ts`, resolved once per render in the route's `load` — inside the
// request's context, which is what lets it read the signed-in viewer. Every chart is server markup
// (an svg and a hidden data table), so the charts add no JavaScript to the route.

import { currentLocale, t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import {
  AreaChart,
  DataTable,
  DonutChart,
  Grid,
  Icon,
  InlineBar,
  RelativeTime,
  Section,
  StatTile,
} from '@ultimat3/ui';
import { iconArrowRight } from '@ultimat3/ui/icons/arrow-right';
import { iconBell } from '@ultimat3/ui/icons/bell';
import { iconMessageSquare } from '@ultimat3/ui/icons/message-square';
import { iconRss } from '@ultimat3/ui/icons/rss';
import { iconUsers } from '@ultimat3/ui/icons/users';
import { currentViewer } from '../../shared/actor';
import { AppShell } from '../../shared/ui/app-shell';
import { PageHeading } from '../../shared/ui/page-heading';
import styles from './page.module.scss';
import { type DashboardScreen, dashboardScreen, type TopPost } from './screen';

export interface DashboardData {
  /** `null` for no viewer — unreachable through HTTP, where `dashboard:read` denies first. */
  readonly screen: DashboardScreen | null;
}

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag: one authz system, evaluated everywhere.
  policy: { permission: 'dashboard:read' },
  // The charts and the table are server markup: they moved no byte of this figure.
  budget: { js: '60kb' },
  // A loader is not the place to assert a viewer exists: an empty page beats a thrown TypeError.
  load: async (): Promise<DashboardData> => {
    const viewer = currentViewer();
    return { screen: viewer === null ? null : await dashboardScreen(viewer, new Date()) };
  },
  meta: () => ({ title: t('app.dashboard.title'), description: t('app.dashboard.description') }),
});

const DESTINATIONS = [
  { name: 'friends', href: '/friends', glyph: iconUsers },
  { name: 'messages', href: '/messages', glyph: iconMessageSquare },
  { name: 'notifications', href: '/notifications', glyph: iconBell },
  { name: 'feed', href: '/feed', glyph: iconRss },
] as const;

function Destinations() {
  return (
    <Section title={t('app.dashboard.goTo')}>
      <ul class={styles.grid}>
        {DESTINATIONS.map((destination) => (
          <li>
            <a class={styles.card} href={destination.href}>
              <span class={styles.icon} aria-hidden="true">
                <Icon glyph={destination.glyph} />
              </span>
              <span class={styles.title}>{t(`app.dashboard.card.${destination.name}.title`)}</span>
              <span class={styles.body}>{t(`app.dashboard.card.${destination.name}.body`)}</span>
              <span class={styles.more} aria-hidden="true">
                <Icon glyph={iconArrowRight} />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Figures(props: { readonly screen: DashboardScreen }) {
  const count = new Intl.NumberFormat(currentLocale());
  const tile = (name: keyof DashboardScreen['stats']) => (
    <StatTile
      stat={`dashboard-${name}`}
      label={t(`app.dashboard.stats.${name}.label`)}
      value={count.format(props.screen.stats[name])}
      hint={t(`app.dashboard.stats.${name}.hint`)}
    />
  );
  return (
    // 10rem: two tiles side by side on a phone, four across a monitor.
    <Grid minColumn="10rem">
      {tile('posts')}
      {tile('likes')}
      {tile('friends')}
      {tile('waiting')}
    </Grid>
  );
}

function Charts(props: { readonly screen: DashboardScreen }) {
  const { activity, connections } = props.screen;
  return (
    <div class={styles.charts}>
      <Section
        title={t('app.dashboard.activity.title')}
        description={t('app.dashboard.activity.range')}
      >
        <AreaChart
          label={t('app.dashboard.activity.label')}
          keys={activity.keys}
          keyLabel={t('app.dashboard.activity.key')}
          series={[
            { label: t('app.dashboard.activity.posts'), values: activity.posts },
            { label: t('app.dashboard.activity.likes'), values: activity.likes },
          ]}
        />
      </Section>
      <Section title={t('app.dashboard.connections.title')}>
        <DonutChart
          label={t('app.dashboard.connections.label')}
          segments={[
            { label: t('app.dashboard.connections.friends'), value: connections.friends },
            { label: t('app.dashboard.connections.incoming'), value: connections.incoming },
            { label: t('app.dashboard.connections.outgoing'), value: connections.outgoing },
            { label: t('app.dashboard.connections.declined'), value: connections.declined },
          ]}
          centreLabel={t('app.dashboard.connections.total')}
          keyLabel={t('app.dashboard.connections.key')}
          valueLabel={t('app.dashboard.connections.value')}
        />
      </Section>
    </div>
  );
}

function TopPosts(props: { readonly screen: DashboardScreen }) {
  const locale = currentLocale();
  const count = new Intl.NumberFormat(locale);
  const most = props.screen.top[0]?.likes ?? 0;
  return (
    <Section title={t('app.dashboard.top.title')}>
      <DataTable
        caption={t('app.dashboard.top.caption')}
        rows={props.screen.top}
        rowKey={(row: TopPost) => row.id}
        emptyTitle={t('app.dashboard.top.empty')}
        columns={[
          {
            key: 'body',
            header: t('app.dashboard.top.post'),
            cell: (row) => <span class={styles.excerpt}>{row.body}</span>,
          },
          {
            key: 'author',
            header: t('app.dashboard.top.author'),
            priority: 2,
            cell: (row) => <span>@{row.authorHandle}</span>,
          },
          {
            key: 'likes',
            header: t('app.dashboard.top.likes'),
            numeric: true,
            cell: (row) => (
              <InlineBar value={row.likes} max={most} text={count.format(row.likes)} />
            ),
          },
          {
            key: 'comments',
            header: t('app.dashboard.top.comments'),
            numeric: true,
            priority: 2,
            cell: (row) => <span>{count.format(row.comments)}</span>,
          },
          {
            key: 'published',
            header: t('app.dashboard.top.published'),
            priority: 2,
            cell: (row) => (
              <RelativeTime value={row.publishedAt} now={props.screen.now} locale={locale} />
            ),
          },
        ]}
      />
    </Section>
  );
}

export function Page(props: { readonly data: DashboardData; readonly url?: string | undefined }) {
  const { screen } = props.data;
  return (
    <AppShell url={props.url} width="wide">
      <PageHeading
        eyebrow={t('app.dashboard.eyebrow')}
        title={t('app.dashboard.title')}
        lede={t('app.dashboard.description')}
      />
      <div class={styles.page}>
        {screen === null ? null : <Figures screen={screen} />}
        {screen === null ? null : <Charts screen={screen} />}
        {screen === null ? null : <TopPosts screen={screen} />}
        <Destinations />
      </div>
    </AppShell>
  );
}
