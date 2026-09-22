// Channels in the contract diff and the build: name and params are the wire contract, the policy
// is judged on the permissions it requires, and a file written before channels existed stays
// readable and diffs as "no channels", never as every channel removed.

import { describe, expect, test } from 'bun:test';
import { buildManifest } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixtures';
import { type ChannelFact, isManifest } from './schema';

const feed = (over: Partial<ChannelFact> = {}): ChannelFact => ({
  name: 'org-feed',
  params: ['orgId'],
  catchUp: 'orgFeed',
  records: ['posts'],
  events: false,
  policy: 'post:read',
  permissions: ['post:read'],
  ...over,
});

const paths = (before: ChannelFact[], after: ChannelFact[]) =>
  diffManifest(fixtureManifest({ channels: before }), fixtureManifest({ channels: after }))
    .changes.filter((change) => change.path.startsWith('channels'))
    .map((change) => [change.kind, change.path]);

describe('channels in the contract diff', () => {
  test('added is additive, removed is breaking', () => {
    expect(paths([], [feed()])).toEqual([['additive', 'channels.org-feed']]);
    expect(paths([feed()], [])).toEqual([['breaking', 'channels.org-feed']]);
  });

  test('params — the topic a client spells — moving is breaking', () => {
    expect(paths([feed()], [feed({ params: ['orgId', 'room'] })])).toEqual([
      ['breaking', 'channels.org-feed.params'],
    ]);
  });

  test('a newly required permission is breaking; a dropped one widens access', () => {
    expect(
      paths([feed()], [feed({ policy: 'post:admin', permissions: ['post:admin'] })]).sort(),
    ).toEqual(
      [
        ['breaking', 'channels.org-feed.policy'],
        ['breaking', 'channels.org-feed.permissions.post:admin'],
        ['additive', 'channels.org-feed.permissions.post:read'],
      ].sort(),
    );
  });

  test('a record type or the events stream lost is breaking, gained is additive', () => {
    expect(paths([feed()], [feed({ records: ['comments'], events: true })]).sort()).toEqual(
      [
        ['breaking', 'channels.org-feed.records.posts'],
        ['additive', 'channels.org-feed.records.comments'],
        ['additive', 'channels.org-feed.events'],
      ].sort(),
    );
  });

  test('a file written before channels existed diffs as none, not as every one removed', () => {
    const { channels: _dropped, ...legacy } = fixtureManifest({ channels: [feed()] });
    expect(isManifest(legacy)).toBe(true);
    const diff = diffManifest(legacy, fixtureManifest({ channels: [feed()] }));
    expect(diff.changes.filter((change) => change.path.startsWith('channels'))).toEqual([
      { kind: 'additive', path: 'channels.org-feed', detail: 'channel added' },
    ]);
    expect(isManifest({ ...legacy, channels: 'broken' })).toBe(false);
  });
});

describe('channels in the build', () => {
  test('sorted by name, records and permissions sorted, params kept in declared order', () => {
    const manifest = buildManifest({
      app: { name: 'a', version: '1.0.0' },
      channels: [
        feed({
          name: 'zeta',
          params: ['to', 'from'],
          records: ['b', 'a'],
          permissions: ['y', 'x'],
        }),
        feed(),
      ],
    });
    expect(manifest.channels?.map((channel) => channel.name)).toEqual(['org-feed', 'zeta']);
    expect(manifest.channels?.[1]).toMatchObject({
      params: ['to', 'from'],
      records: ['a', 'b'],
      permissions: ['x', 'y'],
    });
    // A channel's permissions are the app's permissions, derived like an operation's.
    expect(manifest.permissions).toEqual(['post:read', 'x', 'y']);
  });
});
