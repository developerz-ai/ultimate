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
  titleKey: 'dev.panel.live.title',
  questionKey: 'dev.panel.live.question',
  async data(sources, params): Promise<LivePanelData> {
    const queries = (await sources.liveQueries()).filter((query) => query.live);
    // The subscriber list needs a running sync node; without one the panel still shows the
    // registered live queries rather than an empty tab. `wired` is kept apart from the list
    // itself: `[]` is what a *running* node with nobody attached answers too, and folding the
    // two into one empty array made a genuinely idle live tier print "no sync node" — the same
    // "an empty list is not the same answer as no detector" argument `panel-timeline.ts` makes.
    let subscribers: readonly LiveSubscriberFact[] = [];
    let wired = true;
    try {
      subscribers = await sources.subscribers();
    } catch {
      wired = false;
    }
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
      note: wired ? null : 'dev.live.no-sync-node',
    };
  },
};
