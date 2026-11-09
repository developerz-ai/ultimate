// The hop rule, pure: pins in, hop and section out. The heading test reads the real wiki page, so a
// walkthrough heading edited away from the rule fails here rather than as a dead link in a report.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import type { UpgradePin } from './upgrade-plan';
import { pinVersion, planHop, sectionFor } from './upgrade-plan';

const VERSIONS = [
  '6.0.0',
  '7.0.0',
  '7.1.0',
  '19.0.0',
  '19.4.0',
  '20.0.0',
  '20.2.0-rc.1',
  '20.1.3',
  '21.0.0',
];

const pins = (...specs: readonly string[]): readonly UpgradePin[] =>
  specs.map((spec, index) => ({
    file: index === 0 ? 'package.json' : `apps/app${String(index)}/package.json`,
    name: '@ultimat3/core',
    spec,
  }));

describe('unit · pinVersion', () => {
  test.each([
    ['19.4.0', '19.4.0'],
    ['^19.4.0', '19.4.0'],
    ['~19.4.0', '19.4.0'],
    ['>=19.4.0', '19.4.0'],
    ['^19', '19.0.0'],
    ['19.x', '19.0.0'],
    ['^19.4', '19.4.0'],
  ])('%s reads as %s', (spec, version) => {
    expect(pinVersion(spec)).toBe(version);
  });

  test.each(['workspace:*', 'file:../core', 'link:@ultimat3/core', 'catalog:', 'latest', '*', ''])(
    '%s names no version',
    (spec) => {
      expect(pinVersion(spec)).toBeUndefined();
    },
  );
});

describe('unit · planHop', () => {
  test('19.x hops to the newest release of 20, prereleases never counted', () => {
    const hop = planHop({ pins: pins('^19.4.0'), versions: VERSIONS });
    expect(hop.from).toBe('19.4.0');
    expect(hop.to).toBe('20.1.3');
    expect(hop.next).toBe('21.0.0');
    expect(hop.atTarget).toBe(false);
    expect(hop.section?.title).toBe('19.x → 20.0.0, entry by entry');
  });

  test('a gap in the majors hops to the next one that was published', () => {
    const hop = planHop({ pins: pins('7.1.0'), versions: VERSIONS });
    expect(hop.to).toBe('19.4.0');
  });

  test('a mixed set refuses, and its fix names the higher version', () => {
    expect(() => planHop({ pins: pins('^19.4.0', '^19.0.0'), versions: VERSIONS })).toThrow(
      'X_UPGRADE_MIXED_PINS',
    );
    try {
      planHop({ pins: pins('^19.4.0', '^19.0.0'), versions: VERSIONS });
      expect.unreachable('a mixed set must refuse');
    } catch (error) {
      expect((error as { fix: string }).fix).toBe('x upgrade --to 19.4.0 --json');
      // The one lagging, not the first one read: that is the file an agent has to go and look at.
      expect((error as { cause: string }).cause).toContain('1 of 2 below 19.4.0');
      expect((error as { cause: string }).cause).toContain('apps/app1/package.json');
      expect((error as { cause: string }).cause).not.toContain(
        'package.json: @ultimat3/core ^19.4.0',
      );
    }
  });

  test('the mixed refusal closes: its own fix is accepted', () => {
    const near = planHop({ pins: pins('^19.4.0', '^19.0.0'), to: '19.4.0', versions: VERSIONS });
    expect(near).toMatchObject({ from: '19.0.0', to: '19.4.0', atTarget: false, section: null });
    const low = planHop({ pins: pins('^19.0.0', '^6.0.0'), to: '7.1.0', versions: VERSIONS });
    expect(low).toMatchObject({ from: '6.0.0', to: '7.1.0', next: '19.4.0', atTarget: false });
    expect(low.section?.title).toBe('6.x → 7.0.0, entry by entry');
  });

  // Jumping the stragglers to the highest major skips every walkthrough between: twelve majors'
  // edits landing in one hop, and a red gate that attributes its finding to none of them.
  test('the stragglers never jump to the highest major: one major per run, for them too', () => {
    try {
      planHop({ pins: pins('^19.0.0', '^6.0.0'), to: '19.0.0', versions: VERSIONS });
      expect.unreachable('a straggler skipping majors must refuse');
    } catch (error) {
      expect((error as { code: string }).code).toBe('X_UPGRADE_HOP_TOO_WIDE');
      expect((error as { fix: string }).fix).toBe('x upgrade --to 7.1.0 --json');
    }
  });

  test('--to skipping a major refuses, naming the newest of the next one', () => {
    try {
      planHop({ pins: pins('19.4.0'), to: '21.0.0', versions: VERSIONS });
      expect.unreachable('a skipped major must refuse');
    } catch (error) {
      expect((error as { code: string }).code).toBe('X_UPGRADE_HOP_TOO_WIDE');
      expect((error as { fix: string }).fix).toBe('x upgrade --to 20.1.3 --json');
    }
  });

  test('--to inside the next major is taken as given', () => {
    const hop = planHop({ pins: pins('19.4.0'), to: '20.0.0', versions: VERSIONS });
    expect(hop).toMatchObject({ to: '20.0.0', next: '21.0.0' });
    expect(hop.section?.title).toBe('19.x → 20.0.0, entry by entry');
  });

  test('--to below what is pinned refuses: a hop never moves backwards', () => {
    expect(() => planHop({ pins: pins('19.4.0'), to: '19.0.0', versions: VERSIONS })).toThrow(
      'X_UPGRADE_HOP_TOO_WIDE',
    );
  });

  test('--to npm does not have refuses', () => {
    expect(() => planHop({ pins: pins('19.4.0'), to: '20.9.9', versions: VERSIONS })).toThrow(
      'X_UPGRADE_VERSION_UNPUBLISHED',
    );
  });

  test('at latest answers at-latest, with nowhere next and no section', () => {
    const hop = planHop({ pins: pins('21.0.0'), versions: VERSIONS });
    expect(hop).toEqual({
      from: '21.0.0',
      to: '21.0.0',
      next: null,
      atTarget: true,
      section: null,
    });
  });

  test('the last major, behind on minors, moves to its newest and names no section', () => {
    const hop = planHop({ pins: pins('20.0.0'), versions: ['20.0.0', '20.1.3'] });
    expect(hop).toMatchObject({ to: '20.1.3', next: null, atTarget: false, section: null });
  });

  test('a spec naming no version refuses, and the cause names the file', () => {
    try {
      planHop({ pins: pins('workspace:*'), versions: VERSIONS });
      expect.unreachable('an unreadable pin must refuse');
    } catch (error) {
      expect((error as { code: string }).code).toBe('X_UPGRADE_PIN_UNREADABLE');
      expect((error as { cause: string }).cause).toContain('package.json');
      expect((error as { cause: string }).cause).toContain('workspace:*');
    }
  });

  test('no pin at all refuses', () => {
    expect(() => planHop({ pins: [], versions: VERSIONS })).toThrow('X_UPGRADE_PIN_UNREADABLE');
  });
});

describe('unit · a refusal on a mixed set always closes', () => {
  const two = (first: string, second: string) => pins(first, second);
  const refusedFix = (input: Parameters<typeof planHop>[0]): string => {
    try {
      planHop(input);
    } catch (error) {
      return (error as { fix: string }).fix;
    }
    return expect.unreachable('this must refuse');
  };
  const REAL = ['6.0.0', '7.0.0', '19.0.0', '19.4.0', '20.2.1', '21.0.0'];

  test("--to too wide over a mixed set names the lowest pins' next major, and that is accepted", () => {
    const fix = refusedFix({ pins: two('^6.0.0', '^19.0.0'), to: '21.0.0', versions: REAL });
    expect(fix).toBe('x upgrade --to 7.0.0 --json');
    expect(planHop({ pins: two('^6.0.0', '^19.0.0'), to: '7.0.0', versions: REAL }).to).toBe(
      '7.0.0',
    );
  });

  test('--to at or below the lowest pin of a mixed set moves nothing, and refuses', () => {
    expect(refusedFix({ pins: two('^6.0.0', '^19.0.0'), to: '6.0.0', versions: REAL })).toBe(
      'x upgrade --to 7.0.0 --json',
    );
  });

  // The adopter's shape: two workspaces a dozen majors apart. Every run is one major for the
  // lowest pins, each with its walkthrough, until the last one levels the set.
  test('19.x beside 22.x walks 19 → 20 → 21 → 22, one major and one section per run', () => {
    const versions = ['19.4.0', '20.0.0', '20.1.3', '21.0.0', '22.0.0', '22.1.0'];
    const walk: string[] = [];
    let held = two('22.1.0', '^19.4.0');
    for (let run = 0; run < 5; run += 1) {
      let to: string;
      try {
        const bare = planHop({ pins: held, versions });
        if (bare.atTarget) break;
        to = bare.to;
      } catch (error) {
        expect((error as { code: string }).code).toBe('X_UPGRADE_MIXED_PINS');
        to = (error as { fix: string }).fix.split(' ')[3] ?? '';
      }
      const hop = planHop({ pins: held, to, versions });
      walk.push(`${hop.from}→${hop.to} ${hop.section?.title ?? '-'} next ${String(hop.next)}`);
      held = two('22.1.0', hop.to);
    }
    expect(walk).toEqual([
      '19.4.0→20.1.3 19.x → 20.0.0, entry by entry next 21.0.0',
      '20.1.3→21.0.0 20.x → 21.0.0, entry by entry next 22.1.0',
      '21.0.0→22.1.0 21.x → 22.0.0, entry by entry next null',
    ]);
  });

  test('the mixed fix never names an unpublished version', () => {
    const versions = ['19.1.0', '19.2.0', '19.4.0'];
    const fix = refusedFix({ pins: two('^19.1.0', '^19.3.0'), versions });
    expect(fix).toBe('x upgrade --to 19.4.0 --json');
    expect(planHop({ pins: two('^19.1.0', '^19.3.0'), to: '19.4.0', versions }).to).toBe('19.4.0');
  });

  test('a high pin past every release of its major still gets a version that exists', () => {
    const versions = ['19.1.0', '20.0.0'];
    const fix = refusedFix({ pins: two('^19.1.0', '^19.3.0'), versions });
    expect(fix).toBe('x upgrade --to 20.0.0 --json');
    expect(planHop({ pins: two('^19.1.0', '^19.3.0'), to: '20.0.0', versions }).to).toBe('20.0.0');
  });
});

describe('unit · sectionFor', () => {
  test('the url is GitHub wiki anchor, as the live page serves it (probed 2026-11-02)', () => {
    expect(sectionFor(29).url).toBe(
      'https://github.com/developerz-ai/ultimate/wiki/Upgrading#28x--2900-entry-by-entry',
    );
  });

  // The same section, offline: `x docs <local>` prints it whole from the wiki the CLI ships.
  test('local is the x docs topic for the same anchor', () => {
    expect(sectionFor(29).local).toBe('wiki.Upgrading#28x--2900-entry-by-entry');
  });

  test('the three recorded exceptions', () => {
    expect(sectionFor(5).title).toBe('4.1.0 → 5.0.0, entry by entry');
    expect(sectionFor(4).title).toBe('3.0.0 → 4.0.0, entry by entry');
    expect(sectionFor(3).title).toBe('2.0.0 → 3.0.0, entry by entry');
  });

  test('every walkthrough heading in wiki/Upgrading.md is what the rule builds', async () => {
    const page = await Bun.file(join(import.meta.dir, '../../../wiki/Upgrading.md')).text();
    const headings = [...page.matchAll(/^## (.+ → (\d+)\.0\.0, entry by entry)$/gm)];
    expect(headings.length).toBeGreaterThanOrEqual(28);
    for (const [, heading = '', major = '0'] of headings) {
      expect(sectionFor(Number(major)).title).toBe(heading);
    }
  });
});
