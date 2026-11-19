// The optional sections of the manifest (`mounts`, `consumers`): sets in any declaration order,
// and no key at all when an app declares none.
import { describe, expect, test } from 'bun:test';
import { buildManifest } from './build';
import { manifestJson } from './emit';

// A file an app with no mount has committed must not move: the key's absence is the whole fact,
// and writing `mounts: []` would stale every manifest in existence for nothing.
describe('the mounts section', () => {
  const app = { name: 'acme', version: '1.0.0' };

  test('prefixes, scopes and names are sets: declaration order moves no byte', () => {
    const forward = buildManifest({
      app,
      mounts: [
        { prefix: '/a', scopes: { read: ['listA'] } },
        { prefix: '/v1', scopes: { read: ['listB', 'listA'], audit: ['log'] } },
      ],
    });
    const backward = buildManifest({
      app,
      mounts: [
        { prefix: '/v1', scopes: { audit: ['log'], read: ['listA', 'listB'] } },
        { prefix: '/a', scopes: { read: ['listA'] } },
      ],
    });
    expect(manifestJson(forward)).toBe(manifestJson(backward));
    expect(forward.buildId).toBe(backward.buildId);
    expect(forward.mounts?.map((mount) => mount.prefix)).toEqual(['/a', '/v1']);
    expect(Object.keys(forward.mounts?.[1]?.scopes ?? {})).toEqual(['audit', 'read']);
    expect(forward.mounts?.[1]?.scopes['read']).toEqual(['listA', 'listB']);
  });

  test('no mount writes no key, so an app without one keeps its bytes and its buildId', () => {
    const none = buildManifest({ app });
    expect('mounts' in none).toBe(false);
    expect(manifestJson(none)).not.toContain('mounts');
    expect(buildManifest({ app, mounts: [] }).buildId).toBe(none.buildId);
  });
});

// `mounts`' rule, for the same reason: an app without a consumer keeps its committed bytes.
describe('the consumers section', () => {
  const app = { name: 'acme', version: '1.0.0' };
  const row = (name: string) => ({
    name,
    queue: 'default',
    supervisor: `${name}.supervisor`,
    arm: `${name}.arm`,
    rearm: '* * * * *',
    batch: 100,
    lags: false,
  });

  test('sorted by name: declaration order moves no byte', () => {
    const forward = buildManifest({ app, consumers: [row('b'), row('a')] });
    const backward = buildManifest({ app, consumers: [row('a'), row('b')] });
    expect(manifestJson(forward)).toBe(manifestJson(backward));
    expect(forward.consumers?.map((consumer) => consumer.name)).toEqual(['a', 'b']);
  });

  test('no consumer writes no key, so an app without one keeps its bytes and its buildId', () => {
    const none = buildManifest({ app });
    expect('consumers' in none).toBe(false);
    expect(buildManifest({ app, consumers: [] }).buildId).toBe(none.buildId);
  });
});
