// Realtime channels in a contract diff. A client derives a channel's topic from its NAME and
// PARAMS, so either moving breaks every page built against the old ones; its subscribe policy is
// judged like any operation's, on the permissions it requires.

import { canonicalJson } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';
import { index } from './diff-change';
import { diffPermissions } from './diff-operations';
import type { ChannelFact } from './schema';

export function diffChannels(
  before: readonly ChannelFact[],
  after: readonly ChannelFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (c) => c.name);
  const beforeByName = index(before, (c) => c.name);

  for (const channel of before) {
    const next = afterByName.get(channel.name);
    const path = `channels.${channel.name}`;
    if (next === undefined) {
      changes.push({ kind: 'breaking', path, detail: 'channel removed' });
      continue;
    }
    if (canonicalJson(channel.params) !== canonicalJson(next.params)) {
      changes.push({ kind: 'breaking', path: `${path}.params`, detail: 'params changed' });
    }
    if (channel.policy !== next.policy) {
      changes.push({
        kind: 'breaking',
        path: `${path}.policy`,
        detail: `policy ${channel.policy} -> ${next.policy}`,
      });
    }
    changes.push(...diffPermissions(path, channel, next));
    // Losing a record type or the events stream breaks a page that renders them; gaining one
    // breaks nobody.
    for (const type of channel.records) {
      if (!next.records.includes(type)) {
        changes.push({
          kind: 'breaking',
          path: `${path}.records.${type}`,
          detail: 'no longer carried',
        });
      }
    }
    for (const type of next.records) {
      if (!channel.records.includes(type)) {
        changes.push({ kind: 'additive', path: `${path}.records.${type}`, detail: 'now carried' });
      }
    }
    if (channel.events !== next.events) {
      changes.push({
        kind: next.events ? 'additive' : 'breaking',
        path: `${path}.events`,
        detail: `events ${String(channel.events)} -> ${String(next.events)}`,
      });
    }
    if (channel.catchUp !== next.catchUp) {
      changes.push({
        kind: 'internal',
        path: `${path}.catchUp`,
        detail: `catch-up read ${channel.catchUp} -> ${next.catchUp}`,
      });
    }
  }
  for (const channel of after) {
    if (!beforeByName.has(channel.name)) {
      changes.push({ kind: 'additive', path: `channels.${channel.name}`, detail: 'channel added' });
    }
  }
  return changes;
}
