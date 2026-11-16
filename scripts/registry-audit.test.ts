// The audit's four answers and its one non-answer, driven by fixtures — and the healthy answer now
// carries a finding of its own when npm's `latest` is not the version this tree stamps. The network
// is injected on purpose: a test that resolves npm reports the registry's mood, not this repo's
// state — and the measured propagation lag (minutes, PUBLISHING.md) makes "absent" the flakiest
// possible fixture.

import { describe, expect, test } from 'bun:test';
import type { ScriptResult } from './lib/log';
import { ScriptError } from './lib/script-error';
import type { PublishState, RegistryFetch } from './registry-audit';
import {
  auditRegistry,
  findingFor,
  ordinalLabel,
  packumentUrl,
  registryAuditResult,
  registryFindings,
} from './registry-audit';

test('the tag probe scopes credentials to GitHub, never every HTTP remote', async () => {
  // A child gets only a fixture token; the test neither reads nor changes the runner's credential.
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { remoteTagProbe } from ${JSON.stringify(new URL('./registry-audit.ts', import.meta.url).href)};
      await remoteTagProbe('.', async (command) => {
        console.log(JSON.stringify(command));
        return { command, code: 0, ok: true, output: '', durationMs: 0, timedOut: false };
      })('v9.0.0');`,
    ],
    { env: { ...Bun.env, GITHUB_TOKEN: 'registry-audit-fixture' }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual([
    'git',
    '-c',
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${btoa('x-access-token:registry-audit-fixture')}`,
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    'refs/tags/v9.0.0',
  ]);
});

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

/** An empty audit must fail the test loudly, never hand `findingFor` a fabricated state. */
const only = (states: readonly PublishState[]): PublishState => {
  const first = states[0];
  if (first === undefined || states.length !== 1) {
    throw new ScriptError({
      code: 'X_CLI_UNEXPECTED',
      cause: `the audit answered ${states.length} states where the fixture supplies one`,
      fix: 'pass exactly one target to auditRegistry() in scripts/registry-audit.test.ts',
    });
  }
  return first;
};

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

const target = (name: string, version = '3.0.0'): { name: string; version: string } => ({
  name,
  version,
});

describe('a network failure is never reported as absent', () => {
  test('a fetch that throws is unreachable, and says so', async () => {
    const thrown: RegistryFetch = () => Promise.reject(new Error('ETIMEDOUT'));
    const states = await auditRegistry([target('@ultimat3/core')], thrown);
    expect(states[0]?.kind).toBe('unreachable');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_UNREACHABLE');
    expect(finding?.cause).toContain('ETIMEDOUT');
    // The whole point of the separate outcome: nobody may read a timeout as a bootstrap.
    expect(finding?.cause).toContain('not evidence');
    expect(finding?.fix).not.toContain('npm publish');
  });

  test('a rate limit is unreachable, not absent', async () => {
    const limited = fetcherFor({
      [packumentUrl('@ultimat3/core')]: { body: '{"error":"rate limit"}', status: 429 },
    });
    const states = await auditRegistry([target('@ultimat3/core')], limited);
    expect(states[0]?.kind).toBe('unreachable');
    expect(findingFor(only(states))?.cause).toContain('429');
  });

  test('a 200 that is not a packument is unreachable, not present', async () => {
    const html = fetcherFor({ [packumentUrl('@ultimat3/core')]: { body: '<html>maintenance' } });
    expect((await auditRegistry([target('@ultimat3/core')], html))[0]?.kind).toBe('unreachable');
    // Valid JSON, and still not a packument — the shape guard, not the parse, is what catches it.
    const nul = fetcherFor({ [packumentUrl('@ultimat3/core')]: { body: 'null' } });
    expect((await auditRegistry([target('@ultimat3/core')], nul))[0]?.kind).toBe('unreachable');
  });
});

describe('absent from the registry names the ordinal and the cost', () => {
  test('the third of four says a run publishes two before it dies', async () => {
    const names = ['a', 'b', 'c', 'd'].map((n) => target(`@ultimat3/${n}`));
    const present = Object.fromEntries(
      names
        .filter((entry) => entry.name !== '@ultimat3/c')
        .map((entry) => [
          packumentUrl(entry.name),
          { body: packument(entry.name, { '3.0.0': attested }, '3.0.0') },
        ]),
    );
    const findings = registryFindings(await auditRegistry(names, fetcherFor(present)));
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe('X_REGISTRY_BOOTSTRAP_OWED');
    expect(finding?.cause).toContain('3rd of 4');
    expect(finding?.cause).toContain('publishes 2');
    // The bootstrap command PUBLISHING.md step 1 names, verbatim — never a re-run of the workflow.
    expect(finding?.fix).toContain('npm publish -w @ultimat3/c --access public --provenance=false');
  });

  test('ordinals read as English, 11th through 13th included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 27, 30].map(ordinalLabel)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '27th',
      '30th',
    ]);
  });
});

describe('present but behind the stamped version', () => {
  test('the registry holding only the previous version is behind, not ok', async () => {
    const behind = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '2.0.0': attested }, '2.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core', '3.0.0')], behind);
    expect(states[0]?.kind).toBe('behind');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_VERSION_BEHIND');
    expect(finding?.cause).toContain('2.0.0');
    expect(finding?.cause).toContain('3.0.0');
    expect(finding?.fix).toContain('gh workflow run release.yml --ref v3.0.0 -f version=3.0.0');
  });
});

describe('present at the stamped version, hand-published', () => {
  test('no dist.attestations is a finding that names who published it', async () => {
    const unattested = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '2.0.0': handPublished }, '2.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core', '2.0.0')], unattested);
    expect(states[0]?.kind).toBe('unattested');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_UNATTESTED');
    expect(finding?.cause).toContain('sebyx07');
    expect(finding?.fix).toContain('bun run scripts/trust-publishers.ts');
  });

  test('an attested version is ok and produces no finding', async () => {
    const good = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '3.0.0': attested }, '3.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core')], good);
    expect(states[0]?.kind).toBe('ok');
    expect(states[0]?.publishedBy).toBe('GitHub Actions');
    expect(findingFor(only(states))).toBeUndefined();
    expect(registryFindings(states)).toHaveLength(0);
  });
});

describe('present, attested, and npm serving another version by default', () => {
  test('an attested version whose latest tag moved is a finding, not a clean ok', async () => {
    const split = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '3.0.0': attested }, '3.1.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core', '3.0.0')], split);
    // The kind does not move: the stamped version IS there and IS attested. What is wrong is which
    // one npm hands a consumer, and `ok` raised no finding to say so.
    expect(only(states).kind).toBe('ok');
    const findings = registryFindings(states);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe('X_REGISTRY_LATEST_DRIFT');
    expect(finding?.cause).toContain('3.0.0');
    expect(finding?.cause).toContain('3.1.0');
    expect(finding?.fix).toContain('npm dist-tag add @ultimat3/core@3.0.0 latest');
  });

  test('a packument carrying no dist-tags is the same split, named `none`', async () => {
    const untagged = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: JSON.stringify({ name: '@ultimat3/core', versions: { '3.0.0': attested } }),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core')], untagged);
    expect(only(states).latest).toBe('none');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_LATEST_DRIFT');
    expect(finding?.cause).toContain('none');
  });
});

describe('the request itself', () => {
  test('a scoped name is escaped for the packument path', () => {
    expect(packumentUrl('@ultimat3/core')).toBe('https://registry.npmjs.org/@ultimat3%2fcore');
  });

  test('a request that never answers aborts on the timeout, as unreachable', async () => {
    const signals: AbortSignal[] = [];
    // Answers only when aborted, which is what a hung connection does — so this passes only while
    // the request carries a REAL deadline. A bare controller here hangs the whole audit.
    const hangs: RegistryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new Error('aborted by the deadline')));
      });
    const states = await auditRegistry([target('@ultimat3/core')], hangs, 5);
    expect(states[0]?.kind).toBe('unreachable');
    expect(findingFor(only(states))?.cause).toContain('aborted by the deadline');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('the floor', () => {
  // "0/0 publishable packages are on npm at unknown, every one attested", `ok: true`: a tree read
  // from the wrong directory answered exactly like a perfect registry.
  test('zero publishable workspaces is a failure, not a clean audit', async () => {
    const neverCalled: RegistryFetch = () => expect.unreachable('nothing to look up');
    const result = await registryAuditResult([], neverCalled);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_CORPUS_UNSCANNED']);
  });

  test('one attested workspace is a clean audit', async () => {
    const fetcher: RegistryFetch = async () =>
      new Response(packument('@ultimat3/core', { '9.0.0': attested }, '9.0.0'));
    const core = {
      dir: 'core',
      name: '@ultimat3/core',
      version: '9.0.0',
      private: false,
      path: '/nowhere/packages/core',
      tier: 0,
      dependsOn: [],
    };
    const asked: string[] = [];
    const result = await registryAuditResult([core], fetcher, async (tag) => {
      asked.push(tag);
      return true;
    });
    expect(asked).toEqual(['v9.0.0']);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('1/1 publishable packages are on npm at 9.0.0, every one attested');
  });
});

describe('behind, and whether its release tag exists yet', () => {
  // CodeRabbit 4200667442: the daily audit can run after a bump lands and BEFORE its tag is pushed,
  // and the fix dispatched the workflow at a `v<version>` ref that did not exist.
  const core = {
    dir: 'core',
    name: '@ultimat3/core',
    version: '3.0.0',
    private: false,
    path: '/nowhere/packages/core',
    tier: 0,
    dependsOn: [],
  };
  const behind = fetcherFor({
    [packumentUrl('@ultimat3/core')]: {
      body: packument('@ultimat3/core', { '2.0.0': attested }, '2.0.0'),
    },
  });
  const fixWith = async (tagged: boolean | undefined) => {
    const asked: string[] = [];
    const result = await registryAuditResult([core], behind, async (tag) => {
      asked.push(tag);
      return tagged;
    });
    return { fix: result.findings?.[0]?.fix ?? '', cause: result.findings?.[0]?.cause, asked };
  };

  test('no tag yet: the fix is the release steps, never a dispatch at a missing ref', async () => {
    const { fix, cause, asked } = await fixWith(false);
    expect(asked).toEqual(['v3.0.0']);
    expect(fix).toContain('git tag -a v3.0.0 -m v3.0.0 && git push origin v3.0.0');
    expect(fix).toContain('gh release create v3.0.0 --verify-tag');
    expect(fix).not.toContain('gh workflow run');
    expect(cause).toContain('not tagged');
  });

  test('tagged: the fix dispatches the workflow at that tag', async () => {
    const { fix } = await fixWith(true);
    expect(fix.startsWith('gh workflow run release.yml --ref v3.0.0 -f version=3.0.0')).toBe(true);
  });

  test('unknown: the dispatch runs only once the tag is confirmed', async () => {
    const { fix } = await fixWith(undefined);
    expect(fix).toContain(
      'git ls-remote --exit-code --tags origin refs/tags/v3.0.0 && gh workflow',
    );
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
