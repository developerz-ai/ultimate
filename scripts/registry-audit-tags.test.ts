// The `tagged` stamp the audit puts on every state, and the one seam that decides it: whether the
// release tag `v<version>` exists on the remote. Split from `registry-audit.test.ts`, which owns
// the packument answers, so the file that asks a remote a question is not also the file that reads
// a registry one. Both the fetcher and the tag probe are injected — a test that reached npm or
// `origin` would report that remote's state, not this tree's.

import { describe, expect, test } from 'bun:test';
import type { ScriptResult } from './lib/log';
import { ScriptError } from './lib/script-error';
import type { PublishState, RegistryFetch } from './registry-audit';
import { findingFor, packumentUrl, registryAuditResult, withTags } from './registry-audit';

const attested = {
  dist: { tarball: 'https://registry.npmjs.org/x.tgz', attestations: { url: 'https://x/att' } },
  _npmUser: { name: 'GitHub Actions' },
};

const handPublished = {
  dist: { tarball: 'https://registry.npmjs.org/x.tgz' },
  _npmUser: { name: 'sebyx07' },
};

const packument = (name: string, versions: Record<string, unknown>, latest: string): string =>
  JSON.stringify({ name, 'dist-tags': { latest }, versions });

/** Answers per URL; anything unlisted is a 404, which is what the registry does. */
const fetcherFor = (bodies: Record<string, { body: string; status?: number }>): RegistryFetch => {
  return (url) => {
    const answer = bodies[url];
    if (answer === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(new Response(answer.body, { status: answer.status ?? 200 }));
  };
};

/**
 * `ScriptResult.data` is `unknown` by design, so reading `states` out of it is a parse, not a cast:
 * a result without the states these assertions are about must fail loudly here.
 */
const statesOf = (result: ScriptResult): PublishState[] => {
  const data = result.data;
  if (typeof data !== 'object' || data === null || !('states' in data)) {
    throw new ScriptError({
      code: 'X_CLI_UNEXPECTED',
      cause: 'registryAuditResult() returned no data.states where the fixture expects them',
      fix: 'check the data field of the result in scripts/registry-audit.ts',
    });
  }
  const { states } = data as { readonly states: readonly PublishState[] };
  return [...states];
};

describe('withTags, exported for a caller that already holds probe answers', () => {
  const state = (over: Partial<PublishState> = {}): PublishState => ({
    name: '@ultimat3/core',
    version: '3.0.0',
    ordinal: 1,
    total: 1,
    kind: 'behind',
    ...over,
  });

  test('it asks once per version and attaches the answer to every state', async () => {
    const asked: string[] = [];
    const tagged = await withTags(
      [state(), state({ name: '@ultimat3/cli', version: '3.0.0' }), state({ kind: 'ok' })],
      async (tag) => {
        asked.push(tag);
        return true;
      },
    );
    // Two packages at one version, one question — and an `ok` state carries the answer too:
    // published-and-attested says nothing about whether the release is tagged.
    expect(asked).toEqual(['v3.0.0']);
    expect(tagged.map((s) => s.tagged)).toEqual([true, true, true]);
  });

  test('a denial and a no-answer are different states, not one false', async () => {
    const denied = await withTags([state()], () => Promise.resolve(false));
    const unknown = await withTags([state()], () => Promise.resolve(undefined));
    expect(denied[0]?.tagged).toBe(false);
    expect(unknown[0]?.tagged).toBeUndefined();
  });

  test('the same shape the audit itself consumes: registryAuditResult still sets `tagged`', async () => {
    const fetcher = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '2.0.0': attested }, '2.0.0'),
      },
    });
    const core = {
      dir: 'core',
      name: '@ultimat3/core',
      version: '3.0.0',
      private: false,
      path: '/nowhere/packages/core',
      tier: 0,
      dependsOn: [],
    };
    const result = await registryAuditResult([core], fetcher, () => Promise.resolve(false));
    expect((result.data as { states: readonly PublishState[] }).states[0]?.tagged).toBe(false);
  });
});

describe('tagged is stamped on every state, and asked once per distinct version', () => {
  const workspace = (dir: string, version: string) => ({
    dir,
    name: `@ultimat3/${dir}`,
    version,
    private: false,
    path: `/nowhere/packages/${dir}`,
    tier: 0,
    dependsOn: [],
  });

  /** One audit over six workspaces: ok, unattested, behind, absent, unreachable and a split. */
  const corpus = [
    workspace('core', '9.0.0'),
    workspace('http', '9.0.0'),
    workspace('schema', '9.0.0'),
    workspace('cache', '8.0.0'),
    workspace('flags', '9.0.0'),
    workspace('notify', '9.0.0'),
  ];
  const fetcher: RegistryFetch = async (url) => {
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
    const [pkg, version] = [name.split('/')[1] ?? '', '9.0.0'];
    if (pkg === 'schema') {
      return new Response(packument(name, { '8.0.0': attested }, '8.0.0'));
    }
    if (pkg === 'flags') return new Response('{}', { status: 503 });
    if (pkg === 'cache') return new Response('{}', { status: 404 });
    // Attested at the stamped version, and npm's default tag on another one: the one shape the
    // other five bodies above cannot produce.
    if (pkg === 'notify') return new Response(packument(name, { [version]: attested }, '9.2.0'));
    return new Response(packument(name, { [version]: attested }, version));
  };
  const unattestedFetcher: RegistryFetch = async (url) =>
    url.endsWith('%2fhttp')
      ? new Response(packument('@ultimat3/http', { '9.0.0': handPublished }, '9.0.0'))
      : fetcher(url, { signal: AbortSignal.timeout(1000) });

  test('ok, absent, behind, unattested and unreachable all carry a tagged value', async () => {
    const asked: string[] = [];
    const result = await registryAuditResult(corpus, unattestedFetcher, async (tag) => {
      asked.push(tag);
      return true;
    });
    const states = statesOf(result);
    // Publish order, not array order: `publishOrder` puts the tier-0 bootstrap packages last, and
    // the assertions below are about the KINDS, so read them as a set rather than a sequence.
    const kinds = new Set(states.map((state) => state.kind));
    expect(kinds).toEqual(new Set(['ok', 'absent', 'unattested', 'behind', 'unreachable']));
    expect(states.find((state) => state.kind === 'absent')?.tagged).toBe(true);
    // The bug this pins: `tagged` used to be stamped on `behind` alone, so an `ok` package that
    // was published from an UNTAGGED commit looked exactly like a healthy one.
    for (const state of states) {
      expect(state.tagged).toBe(true);
    }
    // One probe per distinct version — 5 workspaces, 2 stamped versions, 2 questions.
    expect(asked).toHaveLength(2);
    expect([...asked].sort()).toEqual(['v8.0.0', 'v9.0.0']);
  });

  test('an untagged release is `false` everywhere, not only on `behind`', async () => {
    const asked: string[] = [];
    const result = await registryAuditResult(corpus, unattestedFetcher, async (tag) => {
      asked.push(tag);
      return false;
    });
    const states = statesOf(result);
    expect(states.filter((state) => state.kind === 'ok').length).toBeGreaterThan(0);
    expect(states.find((state) => state.kind === 'absent')?.tagged).toBe(false);
    for (const state of states) {
      expect(state.tagged).toBe(false);
    }
    expect(asked).toHaveLength(2);
    expect([...asked].sort()).toEqual(['v8.0.0', 'v9.0.0']);
  });

  test('one moved default tag is one finding, on the ok state that carries it', async () => {
    const result = await registryAuditResult(corpus, unattestedFetcher, async () => true);
    const split = statesOf(result).find((state) => state.name === '@ultimat3/notify');
    if (split === undefined) expect.unreachable('the corpus holds @ultimat3/notify');
    // `kind` stays `ok` — the stamped version is there and attested — and the finding is the only
    // thing that says npm hands a consumer 9.2.0.
    expect(split.kind).toBe('ok');
    expect(findingFor(split)?.code).toBe('X_REGISTRY_LATEST_DRIFT');
    const drift = (result.findings ?? []).filter((one) => one.code === 'X_REGISTRY_LATEST_DRIFT');
    expect(drift.map((one) => one.at)).toEqual(['@ultimat3/notify']);
  });

  test('31 workspaces at one version ask the remote exactly once', async () => {
    const many = Array.from({ length: 31 }, (_, index) =>
      workspace(`pkg-${String(index)}`, '9.1.0'),
    );
    const answers: string[] = [];
    await registryAuditResult(many, fetcher, async (tag) => {
      answers.push(tag);
      return true;
    });
    expect(answers).toEqual(['v9.1.0']);
  });

  test('a git that could not answer leaves `tagged` undefined, never `false`', async () => {
    const asked: string[] = [];
    const result = await registryAuditResult(corpus, unattestedFetcher, async (tag) => {
      asked.push(tag);
      return undefined;
    });
    const states = statesOf(result);
    expect(new Set(states.map((state) => state.kind))).toEqual(
      new Set(['ok', 'absent', 'unattested', 'behind', 'unreachable']),
    );
    // `false` would claim the tag is absent, and the `behind` fix would then prescribe pushing one.
    for (const state of states) {
      expect(state.tagged).toBeUndefined();
      expect('tagged' in state).toBe(false);
    }
    expect([...asked].sort()).toEqual(['v8.0.0', 'v9.0.0']);
  });
});
