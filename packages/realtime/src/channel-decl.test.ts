// `channel()` — the one spelling of a topic, and the params-matching rule a committed row is routed
// by. Every refusal lands at declaration, where the author is.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { recordProjection } from '@ultimat3/entity/record';
import { type ChannelEntity, channel } from './channel-decl';
import { channelRef } from './channel-ref';
import { clearChannels } from './channel-registry';
import { OPEN_POLICY } from './policy-fake';

const posts = entity('channel_decl_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 80 }) },
});
const tags = entity('channel_decl_tags', { columns: { id: uuid().primaryKey(), name: text() } });

afterAll(() => {
  clearRegistry();
  clearChannels();
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const feed = channel('org-feed', {
  params: ['orgId'],
  catchUp: { name: 'orgFeed' },
  policy: OPEN_POLICY,
  records: [posts],
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('channel()', () => {
  test('the topic is the name then each param, in declared order', () => {
    const pair = channel('dm', {
      params: ['a', 'b'],
      catchUp: { name: 'dm' },
      policy: OPEN_POLICY,
    });
    expect(String(pair.topic({ a: 'x', b: 'y' }))).toBe('dm.x.y');
    expect(String(pair.topic({ b: 'y', a: 'x' }))).toBe('dm.x.y');
    expect(feed.catchUp).toBe('orgFeed');
  });

  test('a param value that is not a topic segment is refused', () => {
    expect(codeOf(() => feed.topic({ orgId: 'a.b' }))).toBe('X_TOPIC_FORBIDDEN');
    expect(codeOf(() => feed.topic({ orgId: '>' }))).toBe('X_TOPIC_FORBIDDEN');
  });

  test('an inherited member is not a param value', () => {
    const inherited = Object.create({ orgId: ORG }) as { orgId: string };
    expect(codeOf(() => feed.topic(inherited))).toBe('X_TOPIC_FORBIDDEN');
  });

  test('records carry the entity projection, read off its brand', () => {
    expect(feed.records.map((projection) => projection.type)).toEqual(['channel_decl_posts']);
    expect(feed.records[0]).toBe(recordProjection(posts));
  });

  test('a param no listed entity has as a column is a declaration error', () => {
    const run = () =>
      channel('tag-feed', {
        params: ['orgId'],
        catchUp: { name: 'tags' },
        policy: OPEN_POLICY,
        records: [tags],
      });
    expect(codeOf(run)).toBe('X_CHANNEL_DECLARATION_INVALID');
  });

  test('a lookalike with no record brand is refused, as are bad names and repeated params', () => {
    // Shaped like an entity at the type level, with no record brand at runtime.
    const fake = {
      $name: 'fake',
      $schema: { node: { kind: 'object' } },
    } as unknown as ChannelEntity;
    expect(
      codeOf(() =>
        channel('x', { params: [], catchUp: { name: 'q' }, policy: OPEN_POLICY, records: [fake] }),
      ),
    ).toBe('X_CHANNEL_DECLARATION_INVALID');
    expect(
      codeOf(() => channel('a.b', { params: [], catchUp: { name: 'q' }, policy: OPEN_POLICY })),
    ).toBe('X_CHANNEL_DECLARATION_INVALID');
    expect(
      codeOf(() =>
        channel('x', { params: ['a', 'a'], catchUp: { name: 'q' }, policy: OPEN_POLICY }),
      ),
    ).toBe('X_CHANNEL_DECLARATION_INVALID');
  });

  // A channel with no policy let any socket — anonymous included — join with any param and receive
  // every committed row. An action and a query already require one; a public channel says so.
  test('a channel with no policy is refused, by type and at runtime', () => {
    const run = () =>
      // @ts-expect-error — `policy` is required; `allow('public')` is how a public channel says so
      channel('no-policy', { params: [], catchUp: { name: 'q' } });
    expect(codeOf(run)).toBe('X_CHANNEL_DECLARATION_INVALID');
    const ref = channelRef('no-policy-ref', { params: [], catchUp: { name: 'q' } });
    // @ts-expect-error — the server half of a ref declares its policy too
    expect(codeOf(() => channel(ref, { records: [posts] }))).toBe('X_CHANNEL_DECLARATION_INVALID');
  });

  test('paramsOf reads each param off the row property of the same name', () => {
    expect(feed.paramsOf({ id: 'p1', orgId: ORG, title: 't' })).toEqual({ orgId: ORG });
    // A key-only `before` image names no topic, rather than a wrong one.
    expect(feed.paramsOf({ id: 'p1' })).toBeNull();
    expect(feed.paramsOf({ id: 'p1', orgId: 7 })).toBeNull();
  });
});

describe('catchUp', () => {
  test('the query name is read per access, so a name stamped at boot is the one used', () => {
    const late = { name: '' };
    const decl = channel('late', { params: [], catchUp: late, policy: OPEN_POLICY });
    late.name = 'stampedAtBoot';
    expect(decl.catchUp).toBe('stampedAtBoot');
  });
});

describe('channelRef + channel(ref, …)', () => {
  test('the ref an island holds and the declaration the server registers spell one topic', () => {
    const ref = channelRef('ref-feed', { params: ['orgId'], catchUp: { name: 'refFeedRead' } });
    const declared = channel(ref, { policy: OPEN_POLICY, records: [posts] });
    expect(declared.topic({ orgId: ORG })).toBe(ref.topic({ orgId: ORG }));
    expect(declared.params).toBe(ref.params);
    expect(declared.catchUp).toBe('refFeedRead');
    expect(declared.records[0]?.type).toBe('channel_decl_posts');
  });

  test('a ref registers nothing: only the server half is a declaration', () => {
    channelRef('ref-only', { params: [], catchUp: { name: 'x' } });
    expect(
      codeOf(() =>
        channel('ref-only', { params: [], catchUp: { name: 'x' }, policy: OPEN_POLICY }),
      ),
    ).toBe('did not throw');
  });
});
