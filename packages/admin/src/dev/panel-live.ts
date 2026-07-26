// Panel: Live query inspector.
// Kills: "why did (or didn't) this subscriber get that row?" — every subscriber, what it
// received, and the matcher's decision trace beside it.

import type { LiveQueryFact, LiveSubscriberFact } from './facts';
import type { DevPanel } from './panel';

export interface LivePanelData {
  readonly queries: readonly LiveQueryFact[];
  readonly subscribers: readonly LiveSubscriberFact[];
  /** Registered live queries with nobody attached — usually a client that never subscribed. */
  readonly idleQueries: readonly string[];
  /** Subscribers the matcher rejected, with the reason kept next to them. */
  readonly rejected: readonly {
    readonly id: string;
    readonly query: string;
    readonly trace: readonly string[];
  }[];
  readonly note: string | null;
}

export const livePanel: DevPanel<LivePanelData> = {
  key: 'live',
  titleKey: 'dev.panel.live',
  question: 'what does each subscriber receive, and why?',
  async data(sources, params): Promise<LivePanelData> {
    const queries = (await sources.liveQueries()).filter((query) => query.live);
    // The subscriber list needs a running sync node; without one the panel still shows the
    // registered live queries rather than an empty tab.
    const subscribers = await sources.subscribers().catch((): readonly LiveSubscriberFact[] => []);
    const wanted = params.get('query');
    const scoped =
      wanted === null ? subscribers : subscribers.filter((sub) => sub.query === wanted);
    const attached = new Set(subscribers.map((sub) => sub.query));

    return {
      queries,
      subscribers: scoped,
      idleQueries: queries.filter((query) => !attached.has(query.name)).map((query) => query.name),
      rejected: scoped
        .filter((sub) => !sub.matched)
        .map((sub) => ({ id: sub.id, query: sub.query, trace: sub.trace })),
      note: subscribers.length === 0 ? 'dev.live.no-sync-node' : null,
    };
  },
};
