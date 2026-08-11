// The app's realtime declaration: every channel topic this app publishes on, and the one call that
// installs their guards onto a `ChannelHub`.
//
// It lives here rather than in a feature because a hub is a process-wide object with ONE guard
// list, and the order guards are registered in decides which one answers ("first registered match
// wins" — packages/realtime/src/channel.ts:69). A list assembled in one place is a list that can be
// read; a list assembled by import side effects is a race.
//
// KNOWN GAP, stated rather than hidden: nothing calls `installRealtimeTopics` at boot, because the
// framework offers no seam to. `x dev` and a container both build the hub themselves —
// `new ChannelHub({ transport, sockets })` in packages/cli/src/dev-roles.ts:176 — and never ask the
// app for guards. Until that seam exists every topic below is denied by the hub's own
// deny-by-default rule, which is the safe direction: the guards are declared and tested here, and
// `api/realtime.test.ts` runs them against a real hub.

import type { ChannelHub } from '@ultimat3/realtime';
import { guardConversations } from '../app/messages/topics';
import { guardInboxes } from '../app/notifications/topics';

export { conversationTopic } from '../app/messages/topics';
export { inboxTopic } from '../app/notifications/topics';

/** Every guard this app declares, in registration order. Returns the hub so a boot can chain. */
export const installRealtimeTopics = (hub: ChannelHub): ChannelHub =>
  guardInboxes(guardConversations(hub));
