// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a single-quoted string is the topic-building shape under test.
// The enforcement half of `scripts/channel-literals.ts`, run by the gate's `unit` step like every
// `scripts/**/*.test.ts`. Written against plan 101 slice 09's `channel()` / `useChannel()` /
// `publishRecords()` before that API lands, so every shape is a fixture rather than a tree file.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  CHANNEL_SEAM,
  channelFinding,
  channelLiterals,
  channelResult,
  readChannelSources,
} from './channel-literals';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'examples/app/apps/web/feed.island.tsx';
const kinds = (source: string, file = AT): readonly string[] =>
  channelLiterals(file, source).map((site) => `${site.kind}:${site.via}`);

describe('a topic spelled outside the declaration', () => {
  test('a string literal where a channel is expected is reported, on every channel call', () => {
    expect(kinds("useChannel('posts:1', { onEvent });")).toEqual(['literal:useChannel(']);
    expect(kinds("await hub.subscribe('posts', handler);")).toEqual(['literal:subscribe(']);
    expect(kinds('client.unsubscribe("posts");')).toEqual(['literal:unsubscribe(']);
    expect(kinds("publishRecords('posts', { id }, 'post', rows);")).toEqual([
      'literal:publishRecords(',
    ]);
  });

  test('a topic joined with + or a ${} template is reported as BUILT', () => {
    expect(kinds("hub.publish('posts:' + id, frame);")).toEqual(['built:publish(']);
    expect(kinds('hub.publish(PREFIX + id, frame);')).toEqual(['built:publish(']);
    expect(kinds('useChannel(`posts:${id}`);')).toEqual(['built:useChannel(']);
    expect(kinds('const postTopic = `posts:${id}`;')).toEqual(['built:postTopic']);
    expect(kinds("let channelName = 'org:' + orgId;")).toEqual(['built:channelName']);
  });

  test('the finding is an edit naming the file, the declaration to write and the re-run', () => {
    const [site] = channelLiterals(AT, "useChannel('posts:1');");
    const finding = channelFinding(site ?? expect.unreachable('no site'));
    expect(finding.code).toBe('X_CHANNEL_LITERAL');
    expect(finding.at).toBe(`${AT}:1`);
    expect(finding.fix).toContain('channel(name, { params, policy })');
    expect(finding.fix).toContain('useChannel(decl, params)');
    expect(finding.fix).toContain('bun run channel-literals --json');
  });
});

describe('what passing a channel looks like, and is never reported', () => {
  test('a declaration, a call on one, or an identifier', () => {
    expect(kinds('useChannel(postChannel, { id });')).toEqual([]);
    expect(kinds('publishRecords(feed, { orgId }, posts, rows);')).toEqual([]);
    expect(kinds('const postTopic = postChannel.topic({ id });')).toEqual([]);
    expect(kinds('await ctx.posts.publish(postId(input.postId));')).toEqual([]);
  });

  test('the declaration itself names the channel with a literal, by design', () => {
    expect(kinds("export const feed = channel('feed', { params, policy, catchUp });")).toEqual([]);
  });

  test('a listener is not a topic, even with arithmetic in it', () => {
    expect(kinds('store.subscribe((c) => { if (c.has(t)) set(v() + 1); });')).toEqual([]);
    expect(kinds('signal.subscribe((n) => n + 1);')).toEqual([]);
  });

  test('a string or comment mentioning a call, and a + inside a string, are not sites', () => {
    expect(kinds('log(\'never subscribe("posts") by hand\');')).toEqual([]);
    expect(kinds("// useChannel('posts') was the old spelling\nconst x = 1;")).toEqual([]);
    expect(kinds("hub.publish(decl.topic('a+b'), frame);")).toEqual([]);
  });

  test('a documentation topic in an object property is not a channel — the docs-scan shape', () => {
    expect(kinds('return { topic: `${shortName(name)}.${module}`, kind };')).toEqual([]);
  });

  test('the seam spells topics, and a test is a fixture', () => {
    const source = 'await this.#transport.publish(`${PREFIX}.${name}`, encode(frame));';
    expect(kinds(source, CHANNEL_SEAM)).toEqual([]);
    expect(kinds(source, 'packages/realtime/src/other.ts')).toEqual(['built:publish(']);
    expect(kinds(source, 'packages/realtime/src/hub.test.ts')).toEqual([]);
  });
});

describe('the instrumentation bus is not a channel', () => {
  // `subscribe` from `@ultimat3/core` takes an event NAME the compiler checks against
  // `InstrumentEventMap` — a misspelling is a type error, never a silent drift.
  const EVENTS = 'packages/core/src/instrument-events.ts';
  const events = [
    'export const INSTRUMENT_EVENTS = Object.freeze({',
    "  'cache.invalidate': { span: 'event', owner: '@ultimat3/cache' },",
    "  'render.isr.regenerate': { span: 'internal', owner: '@ultimat3/render' },",
    '});',
  ].join('\n');
  const seam = { path: CHANNEL_SEAM, source: 'const x = 1;' };
  const codes = (source: string): readonly string[] =>
    (
      channelResult([seam, { path: EVENTS, source: events }, { path: AT, source }]).findings ?? []
    ).map((finding) => finding.code);

  test('a declared event, one of its prefixes or every event is a name, not a topic', () => {
    expect(codes("subscribe('cache.invalidate', (event) => log(event));")).toEqual([]);
    expect(codes("subscribe('render.isr', onIsr);")).toEqual([]);
    expect(codes("subscribe('render', onRender);")).toEqual([]);
    expect(codes("subscribe('*', onAny);")).toEqual([]);
  });

  test('a name the event table does not declare is still a topic, and so is any other call', () => {
    expect(codes("subscribe('posts', handler);")).toEqual(['X_CHANNEL_LITERAL']);
    expect(codes("subscribe('cache.invalidated', handler);")).toEqual(['X_CHANNEL_LITERAL']);
    expect(codes("publish('cache.invalidate', frame);")).toEqual(['X_CHANNEL_LITERAL']);
    expect(codes('subscribe(`cache.${kind}`, handler);')).toEqual(['X_CHANNEL_LITERAL']);
  });

  test('with the event table absent from the set, nothing is exempt', () => {
    const result = channelResult([seam, { path: AT, source: "subscribe('cache.invalidate', f);" }]);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_CHANNEL_LITERAL']);
  });
});

describe('the rule over a file set', () => {
  test('a set that never contained the seam is refused, never read as clean', () => {
    const result = channelResult([{ path: AT, source: 'const x = 1;' }]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((f) => f.code)).toEqual(['X_CHANNEL_LITERAL_UNSCANNED']);
  });

  test('the command it names is a script this repo declares', async () => {
    const raw: unknown = await Bun.file(`${repoRoot()}/package.json`).json();
    const scripts = typeof raw === 'object' && raw !== null && 'scripts' in raw ? raw.scripts : {};
    expect(Object.keys(scripts ?? {})).toContain('channel-literals');
  });

  test('the real tree spells every topic through the declaration', async () => {
    const files = await readChannelSources(repoRoot());
    // Non-vacuity: the seam and both tracked apps are in the set the rule read.
    expect(files.some((file) => file.path === CHANNEL_SEAM)).toBe(true);
    expect(files.some((file) => file.path.startsWith('examples/dummy/apps/'))).toBe(true);
    expect(channelResult(files).findings).toEqual([]);
  });
});
