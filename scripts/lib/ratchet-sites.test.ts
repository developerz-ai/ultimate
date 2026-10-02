import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp/rm and exposes no tmpdir(); each case owns a throwaway root.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { GitRunner } from './base-ref';
import { BASE_REF } from './base-ref';
import type { RatchetGap } from './ratchet';
import { ratchetGaps } from './ratchet';
import type { SiteProbe } from './ratchet-sites';
import { leadSite, newSitesFirst, SITE_LIST_MAX, siteList, siteTarget } from './ratchet-sites';

interface Site {
  readonly path: string;
  readonly line: number;
}

/** A scanner as small as one can be: every line reading `bad…` is a site. */
const PROBE: SiteProbe<Site> = {
  rescan: (path, source) =>
    source
      .split('\n')
      .flatMap((text, index) => (text.trim().startsWith('bad') ? [{ path, line: index + 1 }] : [])),
  line: (site) => site.line,
};
const at = (site: Site): string => `${site.path}:${String(site.line)}`;

const roots: string[] = [];
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** A root holding `now`, and a git that answers `then` for the same paths at the base ref. */
async function tree(
  now: Readonly<Record<string, string>>,
  then: Readonly<Record<string, string>> | undefined,
): Promise<{ root: string; git: GitRunner; calls: string[][]; sites: Site[] }> {
  const root = await mkdtemp(`${tmpdir()}/ratchet-sites-`);
  roots.push(root);
  const sites: Site[] = [];
  for (const [path, text] of Object.entries(now)) {
    await Bun.write(`${root}/${path}`, text);
    sites.push(...PROBE.rescan(path, text));
  }
  const calls: string[][] = [];
  const git: GitRunner = async (command) => {
    calls.push([...command]);
    const shown = command[1] === 'show' ? then?.[(command[2] ?? '').split(':')[1] ?? ''] : '';
    const ok = then !== undefined && shown !== undefined;
    return { command, code: ok ? 0 : 1, ok, output: shown ?? '', durationMs: 0 };
  };
  return { root, git, calls, sites };
}

const A = 'packages/ui/src/a.ts';
const B = 'packages/ui/src/b.ts';

describe('unit · which sites of an over gap are new', () => {
  test('the site added since the base comes first, though it is the LAST in scan order', async () => {
    const { root, git, sites } = await tree(
      { [A]: 'bad one\nok\nbad two', [B]: '// moved down\n\nbad three\nbad four' },
      { [A]: 'bad one\nok\nbad two', [B]: 'bad three' },
    );
    const [gap] = await newSitesFirst(root, ratchetGaps(sites, { ui: 3 }, true), PROBE, git);
    // `bad three` moved from line 1 to line 3 and is still the base's: text, never line number.
    expect(gap?.sites?.map(at)).toEqual([`${B}:4`, `${A}:1`, `${A}:3`, `${B}:3`]);
    expect(gap?.fresh).toBe(1);
    expect(gap?.first).toEqual({ path: A, line: 1 });
  });

  test('a duplicate of a line the base holds once is new: the base excuses one, not two', async () => {
    const { root, git, sites } = await tree({ [A]: 'bad x\nbad x' }, { [A]: 'bad x' });
    const [gap] = await newSitesFirst(root, ratchetGaps(sites, { ui: 1 }, true), PROBE, git);
    expect(gap?.sites?.map(at)).toEqual([`${A}:2`, `${A}:1`]);
    expect(gap?.fresh).toBe(1);
  });

  test('a file absent at the base is new in full', async () => {
    const { root, git, sites } = await tree({ [A]: 'bad a', [B]: 'bad b' }, { [A]: 'bad a' });
    const [gap] = await newSitesFirst(root, ratchetGaps(sites, { ui: 1 }, true), PROBE, git);
    expect(gap?.sites?.map(at)).toEqual([`${B}:1`, `${A}:1`]);
  });

  test('no base ref in the checkout: the gaps come back as given, and no file is asked for', async () => {
    const { root, git, calls, sites } = await tree({ [A]: 'bad a\nbad b' }, undefined);
    const gaps = ratchetGaps(sites, { ui: 1 }, true);
    expect(await newSitesFirst(root, gaps, PROBE, git)).toBe(gaps);
    expect(calls).toEqual([['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`]]);
  });

  test('a zero-pinned gap, a stale one and a green tree spawn nothing at all', async () => {
    const { root, git, calls, sites } = await tree({ [A]: 'bad a' }, { [A]: '' });
    for (const pins of [{}, { ui: 1, core: 2 }]) {
      const gaps = ratchetGaps(sites, pins, true);
      expect(await newSitesFirst(root, gaps, PROBE, git)).toBe(gaps);
    }
    expect(calls).toEqual([]);
  });
});

describe('unit · how a finding says its sites', () => {
  const sites = (count: number): Site[] =>
    Array.from({ length: count }, (_, index) => ({ path: A, line: index + 1 }));
  const gap = (count: number, pinned: number, fresh?: number): RatchetGap<Site> => ({
    kind: 'over',
    pkg: 'ui',
    found: count,
    pinned,
    sites: sites(count),
    ...(fresh === undefined ? {} : { fresh }),
  });

  test('every site, in order, when nothing is known about the base', () => {
    expect(siteList(gap(3, 2), at)).toBe(`${A}:1, ${A}:2, ${A}:3`);
    expect(siteTarget(gap(3, 2), at)).toBe(
      '1 of the 3 sites the cause lists — whichever this change added',
    );
  });

  test('new sites are named as new, and the fix points at them', () => {
    expect(siteList(gap(3, 2, 1), at)).toBe(
      `new since ${BASE_REF}: ${A}:1; already there: ${A}:2, ${A}:3`,
    );
    expect(siteTarget(gap(3, 2, 1), at)).toBe(`${A}:1`);
    expect(siteTarget(gap(4, 2, 2), at)).toBe('the 2 sites the cause lists as new');
    expect(siteList(gap(2, 1, 2), at)).toBe(`new since ${BASE_REF}: ${A}:1, ${A}:2`);
  });

  test('with nothing pinned every site is the target, not "whichever was added"', () => {
    expect(siteTarget(gap(3, 0), at)).toBe('each of the 3 sites the cause lists');
  });

  test('a single site is simply named', () => {
    expect(siteList(gap(1, 0), at)).toBe(`${A}:1`);
    expect(siteTarget(gap(1, 0), at)).toBe(`${A}:1`);
    expect(leadSite(gap(1, 0))).toEqual({ path: A, line: 1 });
  });

  test('a long list is cut at the cap and says how to read the rest', () => {
    const listed = siteList(gap(SITE_LIST_MAX + 5, 3), at, 'bun run x --explain');
    expect(listed.split(', ')).toHaveLength(SITE_LIST_MAX);
    expect(listed).toEndWith(' … and 5 more (bun run x --explain)');
    expect(siteList(gap(SITE_LIST_MAX + 5, 3), at)).toEndWith(' … and 5 more');
  });

  test('a gap carrying only its first site still lists it', () => {
    const first = { path: A, line: 9 };
    const bare: RatchetGap<Site> = { kind: 'over', pkg: 'ui', found: 1, pinned: 0, first };
    expect(siteList(bare, at)).toBe(`${A}:9`);
    expect(leadSite(bare)).toBe(first);
    expect(leadSite({ kind: 'stale', pkg: 'ui', found: 0, pinned: 1 })).toBeUndefined();
  });
});
