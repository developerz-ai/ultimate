// `x upgrade`'s decision, pure: the pins an app holds and the versions npm publishes in, the one hop
// a run may make and the wiki section that walks it out. One major per run, so a red gate is that
// hop's. No I/O: `cmd-upgrade.ts` reads, this decides, and every refusal is thrown from here.

import { UltimateError } from '@ultimat3/core';
import { quoteArg } from './shell-quote';

export interface UpgradePin {
  /** The manifest holding it, relative to the app root. */
  readonly file: string;
  readonly name: string;
  readonly spec: string;
}

export interface UpgradeSection {
  readonly title: string;
  readonly url: string;
}

export interface UpgradeHop {
  /** The lowest version any workspace pins. */
  readonly from: string;
  readonly to: string;
  /** What a bare `x upgrade` would take after this hop, or null when nothing is left to take. */
  readonly next: string | null;
  /** Already where this run was aimed: the newest release only when `next` is null. */
  readonly atTarget: boolean;
  /** Null when no major is crossed: a walkthrough exists per major and nothing under one. */
  readonly section: UpgradeSection | null;
}

const WIKI_PAGE = 'https://github.com/developerz-ai/ultimate/wiki/Upgrading';

/** The walkthroughs whose heading names one release rather than `<major-1>.x`, as recorded. */
const RECORDED_FROM: ReadonlyMap<number, string> = new Map([
  [5, '4.1.0'],
  [4, '3.0.0'],
  [3, '2.0.0'],
]);

const PIN = /^(?:\^|~|>=)?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

type Triple = readonly [number, number, number];

const part = (text: string | undefined): number =>
  text === undefined || text === 'x' ? 0 : Number(text);

/** The version a dependency spec starts from, or undefined when it names none (`workspace:*`). */
export function pinVersion(spec: string): string | undefined {
  const match = PIN.exec(spec.trim());
  if (match === null) return undefined;
  return `${part(match[1])}.${part(match[2])}.${part(match[3])}`;
}

/** A plain release's three numbers; a prerelease is not a release, so it answers undefined. */
export function releaseOf(version: string): Triple | undefined {
  const match = RELEASE.exec(version);
  return match === null ? undefined : [part(match[1]), part(match[2]), part(match[3])];
}

const tripleOf = (version: string): Triple => releaseOf(version) ?? [0, 0, 0];

const compare = (a: string, b: string): number => {
  const left = tripleOf(a);
  const right = tripleOf(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

const majorOf = (version: string): number => tripleOf(version)[0];

/** The walkthrough that gets an app into `major`, built from the heading rule. */
export function sectionFor(major: number): UpgradeSection {
  const from = RECORDED_FROM.get(major) ?? `${String(major - 1)}.x`;
  const title = `${from} → ${String(major)}.0.0, entry by entry`;
  // GitHub's slug, read off the live page: lowercase, every other character dropped, then one
  // hyphen per space — the arrow leaves two spaces, so `28x--2900-entry-by-entry`.
  const anchor = title
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replaceAll(' ', '-');
  return { title, url: `${WIKI_PAGE}#${anchor}` };
}

const newestOfMajor = (major: number, released: readonly string[]): string | undefined =>
  released.filter((version) => majorOf(version) === major).at(-1);

const nextMajorNewest = (from: string, released: readonly string[]): string | undefined => {
  const major = released.map(majorOf).find((candidate) => candidate > majorOf(from));
  return major === undefined ? undefined : newestOfMajor(major, released);
};

/** What a bare run takes from `from`: the next major's newest, else this major's newest. */
const bareTarget = (from: string, released: readonly string[]): string | undefined => {
  const next = nextMajorNewest(from, released);
  if (next !== undefined) return next;
  const newest = newestOfMajor(majorOf(from), released);
  return newest !== undefined && compare(newest, from) > 0 ? newest : undefined;
};

const unreadablePin = (cause: string, file: string): UltimateError =>
  new UltimateError({
    code: 'X_UPGRADE_PIN_UNREADABLE',
    cause,
    fix: `x upgrade --json   # after editing ${file} so every @ultimat3/* dependency carries a version`,
  });

/** Every pin's version, or the refusal naming the first pin that has none. */
function readVersions(pins: readonly UpgradePin[]): readonly string[] {
  if (pins.length === 0) {
    throw unreadablePin(
      'no workspace package.json depends on any @ultimat3/* package, so there is no version to hop from',
      'package.json',
    );
  }
  return pins.map((pin) => {
    const version = pinVersion(pin.spec);
    if (version === undefined) {
      throw unreadablePin(
        `${pin.file} depends on ${pin.name} as "${pin.spec}", which names no version to hop from`,
        pin.file,
      );
    }
    return version;
  });
}

/**
 * The version that brings a mixed set level: the newest release in the high pin's major at or above
 * it, since the pin itself may name nothing npm has. Past every release of its major, the next one.
 */
const aligningVersion = (high: string, released: readonly string[]): string => {
  const newest = newestOfMajor(majorOf(high), released);
  if (newest !== undefined && compare(newest, high) >= 0) return newest;
  return nextMajorNewest(high, released) ?? high;
};

const tooWide = (cause: string, target: string | undefined): UltimateError =>
  new UltimateError({
    code: 'X_UPGRADE_HOP_TOO_WIDE',
    cause,
    fix: target === undefined ? 'x upgrade --json' : `x upgrade --to ${quoteArg(target)} --json`,
  });

/** The refusals of an asked-for target; a target that passes is a legal hop. */
function checkTarget(input: {
  readonly to: string;
  readonly low: string;
  readonly high: string;
  readonly released: readonly string[];
}): void {
  const { to, low, high, released } = input;
  if (!released.includes(to)) {
    throw new UltimateError({
      code: 'X_UPGRADE_VERSION_UNPUBLISHED',
      cause: `--to ${to} is not a release npm publishes for @ultimat3/cli`,
      fix: 'bun pm view @ultimat3/cli versions --json   # then: x upgrade --to <one of them> --json',
    });
  }
  // A mixed set has one way out, so every refusal over it names that way: a fix aimed at the next
  // major of the lowest pin would itself be refused, for sitting below the highest.
  const aligning = aligningVersion(high, released);
  const way = low === high ? bareTarget(low, released) : aligning;
  if (compare(to, high) < 0) {
    throw tooWide(`--to ${to} is below the ${high} this app already pins`, way);
  }
  // The second operand is what makes the mixed refusal's own fix runnable: `^6` beside `^19` is told
  // `--to <19.x>`, which brings the straggler level and crosses nothing the rest of the app has not.
  const widest = Math.max(majorOf(nextMajorNewest(low, released) ?? low), majorOf(aligning));
  if (majorOf(to) > widest) {
    throw tooWide(
      `--to ${to} skips a major: from ${low} a run reaches ${String(widest)}.x at most, so each hop's gate attributes its red to that hop`,
      way,
    );
  }
}

/** The one hop this run may make, or the refusal saying why it may not. */
export function planHop(input: {
  readonly pins: readonly UpgradePin[];
  readonly versions: readonly string[];
  readonly to?: string;
}): UpgradeHop {
  const { pins, to } = input;
  const distinct = [...new Set(readVersions(pins))].sort(compare);
  const low = distinct[0] ?? '0.0.0';
  const high = distinct.at(-1) ?? low;
  const released = input.versions.filter((version) => releaseOf(version) !== undefined);
  released.sort(compare);

  if (to === undefined && distinct.length > 1) {
    // The stragglers, not the first few: `^19.4.0` nineteen times says nothing about the one `^19.3.1`.
    const stragglers = pins.filter((pin) => pinVersion(pin.spec) !== high);
    const held = stragglers.map((pin) => `${pin.file}: ${pin.name} ${pin.spec}`);
    throw new UltimateError({
      code: 'X_UPGRADE_MIXED_PINS',
      cause: `the workspaces pin ${distinct.join(', ')}, and the framework only moves in lockstep. ${String(held.length)} of ${String(pins.length)} below ${high}: ${held.slice(0, 6).join('; ')}`,
      fix: `x upgrade --to ${quoteArg(aligningVersion(high, released))} --json`,
    });
  }
  if (to !== undefined) checkTarget({ to, low, high, released });

  const target = to ?? bareTarget(low, released) ?? low;
  const after = bareTarget(target, released) ?? null;
  return {
    from: low,
    to: target,
    next: after,
    atTarget: distinct.length === 1 && target === low,
    section: majorOf(target) > majorOf(high) ? sectionFor(majorOf(target)) : null,
  };
}
