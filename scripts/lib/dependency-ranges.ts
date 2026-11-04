// The npm version-range algebra: parse a declared range into bounds, and decide whether two
// declared ranges can be satisfied by ONE version. Textual inequality is never a verdict — the
// root's `^7.0.2` and an app's `7.0.2` agree, and the root's `^1.0.0` and an app's `^2.0.0` do not.
//
// A range that does not parse is REFUSED, never read as compatible: a range this algebra cannot
// read is a range it never compared, and "never compared" must not read as "no conflict".

/** A semantic version, normalised to three numbers: `major.minor.patch`. */
export type Version = readonly [number, number, number];

/** One end of an interval. `inclusive` says whether the version itself is inside the set. */
export interface VersionBound {
  readonly version: Version;
  readonly inclusive: boolean;
}

/**
 * A set of versions between two bounds. An absent bound is unbounded on that side.
 *
 * `| undefined` is explicit: under `exactOptionalPropertyTypes` a bare `?:` refuses the
 * `undefined` a folded conjunction hands over when one side has no bound at all.
 */
export interface VersionInterval {
  readonly lower?: VersionBound | undefined;
  readonly upper?: VersionBound | undefined;
}

/** One parsed range: the union of its alternatives, each an interval. */
export interface ParsedRange {
  readonly intervals: readonly VersionInterval[];
}

const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const boundAt = (version: Version, inclusive: boolean): VersionBound => ({ version, inclusive });

/** The next patch of a version: the smallest version strictly greater than it. */
const nextPatch = (version: Version): Version => [version[0], version[1], version[2] + 1];

/** The tighter of two lower bounds: the greater version, and exclusive when either one is. */
const lowerOf = (
  a: VersionBound | undefined,
  b: VersionBound | undefined,
): VersionBound | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const order = compareVersions(a.version, b.version);
  if (order > 0) return a;
  if (order < 0) return b;
  return boundAt(a.version, a.inclusive && b.inclusive);
};

/** The tighter of two upper bounds: the lesser version, and exclusive when either one is. */
const upperOf = (
  a: VersionBound | undefined,
  b: VersionBound | undefined,
): VersionBound | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const order = compareVersions(a.version, b.version);
  if (order < 0) return a;
  if (order > 0) return b;
  return boundAt(a.version, a.inclusive && b.inclusive);
};

/**
 * Whether two intervals share at least one version.
 *
 * The versions are DISCRETE, so an interval with no version between its ends is empty: `>1.2.3`
 * and `<1.2.4` have none in common, and a guard that called that compatible would wave through a
 * pair no install can satisfy.
 */
export function intervalsOverlap(a: VersionInterval, b: VersionInterval): boolean {
  const lo = lowerOf(a.lower, b.lower);
  const hi = upperOf(a.upper, b.upper);
  if (lo === undefined || hi === undefined) return true;
  const order = compareVersions(lo.version, hi.version);
  if (order > 0) return false;
  if (order === 0) return lo.inclusive && hi.inclusive;
  // Strictly apart: the lower end is in the set only when it is inclusive, and otherwise the
  // smallest version above it must still reach the upper end.
  if (lo.inclusive) return true;
  const candidate = nextPatch(lo.version);
  return hi.inclusive
    ? compareVersions(candidate, hi.version) <= 0
    : compareVersions(candidate, hi.version) < 0;
}

/** A conjunction of comparators, folded into the one interval it describes. */
const conjunctionOf = (bounds: readonly VersionInterval[]): VersionInterval | undefined => {
  let lower: VersionBound | undefined;
  let upper: VersionBound | undefined;
  for (const bound of bounds) {
    lower = lowerOf(lower, bound.lower);
    upper = upperOf(upper, bound.upper);
  }
  if (lower !== undefined && upper !== undefined) {
    const order = compareVersions(lower.version, upper.version);
    if (order > 0) return undefined;
    if (order === 0 && !(lower.inclusive && upper.inclusive)) return undefined;
  }
  return { lower, upper };
};

/** One parsed version: its three numbers and how many of them were actually stated. */
interface PartialVersion {
  readonly version: Version;
  /** 0 = `*`, 1 = `1`, 2 = `1.2`, 3 = `1.2.3`. */
  readonly precision: number;
}

const VERSION_PART = /^(0|[1-9]\d*)$/;
const WILDCARD_PART = /^(\*|x|X)$/;

/**
 * `1`, `1.2`, `1.2.3`, `1.x`, `1.2.x` — the missing parts filled with zero and the stated
 * precision kept, because npm's caret and tilde bounds depend on how much was written.
 */
export function parseVersion(text: string): PartialVersion | undefined {
  const parts = text.split('.');
  if (parts.length > 3) return undefined;
  const numbers: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (WILDCARD_PART.test(part)) {
      // A wildcard may only end the version: `1.x` and `1.2.x` are versions, `x.2` is not.
      if (index !== parts.length - 1) return undefined;
      break;
    }
    if (!VERSION_PART.test(part)) return undefined;
    numbers.push(Number(part));
  }
  return {
    version: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0],
    precision: numbers.length,
  };
}

/** `^1.2.3` → `<2.0.0`; `^0.5.8` → `<0.6.0`; `^0.0.3` → `<0.0.4`; `^0` → `<1.0.0`. */
const caretUpper = (version: PartialVersion): Version => {
  const [major, minor, patch] = version.version;
  if (major > 0) return [major + 1, 0, 0];
  if (version.precision === 1) return [1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  if (version.precision === 2) return [0, 1, 0];
  return [0, 0, patch + 1];
};

/** `~1.2.3` → `<1.3.0`; `~1.2` → `<1.3.0`; `~1` → `<2.0.0`. */
const tildeUpper = (version: PartialVersion): Version => {
  const [major, minor] = version.version;
  if (version.precision >= 2) return [major, minor + 1, 0];
  return [major + 1, 0, 0];
};

/** The upper end of an `x`-range: `1.2` → `<1.3.0`, `1` → `<2.0.0`, `1.2.3` → `<1.2.4`. */
const xRangeUpper = (version: PartialVersion): VersionBound => {
  if (version.precision >= 3) return boundAt(nextPatch(version.version), false);
  if (version.precision === 2) {
    return boundAt([version.version[0], version.version[1] + 1, 0], false);
  }
  return boundAt([version.version[0] + 1, 0, 0], false);
};

/** The interval one comparator describes, or `undefined` when the operator is unknown. */
const comparatorInterval = (
  operator: string,
  version: PartialVersion,
): VersionInterval | undefined => {
  const lower = boundAt(version.version, true);
  if (operator === '^') return { lower, upper: boundAt(caretUpper(version), false) };
  if (operator === '~') return { lower, upper: boundAt(tildeUpper(version), false) };
  if (operator === '=') return { lower, upper: xRangeUpper(version) };
  if (operator === '>=') return { lower };
  if (operator === '<') return { upper: boundAt(version.version, false) };
  if (operator === '>') {
    if (version.precision >= 3) return { lower: boundAt(version.version, false) };
    // npm's rule for a partial version: `>1.2` means `>=1.3.0`.
    return { lower: boundAt(xRangeUpper(version).version, true) };
  }
  if (operator === '<=') {
    if (version.precision >= 3) return { upper: boundAt(version.version, true) };
    // npm's rule for a partial version: `<=1.2` means `<1.3.0`.
    return { upper: boundAt(xRangeUpper(version).version, false) };
  }
  return undefined;
};

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;

/** One comparator of a conjunction, or `undefined` when it does not parse. */
const parseComparator = (text: string): VersionInterval | undefined => {
  const match = COMPARATOR.exec(text.trim());
  if (match === null) return undefined;
  const operator = match[1] ?? '=';
  const raw = (match[2] ?? '').trim();
  if (raw === '') return undefined;
  const version = parseVersion(raw);
  if (version === undefined) return undefined;
  if (version.precision === 0) {
    // `*` and `x` alone: every version.
    return { lower: boundAt([0, 0, 0], true) };
  }
  return comparatorInterval(operator, version);
};

/** `1.2.3 - 2.3.4`: the hyphen range npm accepts, as its two ends. */
const HYPHEN = /^(\S+)\s+-\s+(\S+)$/;

const parseHyphen = (text: string): VersionInterval | undefined => {
  const match = HYPHEN.exec(text.trim());
  if (match === null) return undefined;
  const lower = parseVersion(match[1] ?? '');
  const upper = parseVersion(match[2] ?? '');
  if (lower === undefined || upper === undefined) return undefined;
  if (lower.precision === 0 || upper.precision === 0) return undefined;
  return {
    lower: boundAt(lower.version, true),
    upper:
      upper.precision >= 3
        ? boundAt(upper.version, true)
        : boundAt(xRangeUpper(upper).version, false),
  };
};

/**
 * Parse a declared range into the union of its alternatives.
 *
 * `undefined` means the range does not parse — the caller must refuse it, never treat it as
 * compatible. A range is: alternatives separated by `||`, each alternative a conjunction of
 * comparators separated by whitespace or a comma.
 */
export function parseVersionRange(range: string): ParsedRange | undefined {
  const trimmed = range.trim();
  if (trimmed === '') return undefined;
  const intervals: VersionInterval[] = [];
  let alternatives = 0;
  for (const alternative of trimmed.split('||')) {
    const text = alternative.trim();
    if (text === '') return undefined;
    const hyphen = parseHyphen(text);
    if (hyphen !== undefined) {
      alternatives += 1;
      intervals.push(hyphen);
      continue;
    }
    const parts = text.split(/[\s,]+/).filter((part) => part !== '');
    if (parts.length === 0) return undefined;
    const bounds: VersionInterval[] = [];
    for (const part of parts) {
      const interval = parseComparator(part);
      if (interval === undefined) return undefined;
      bounds.push(interval);
    }
    alternatives += 1;
    const conjunction = conjunctionOf(bounds);
    // An empty conjunction is a range that matches nothing, not a range that failed to parse.
    if (conjunction !== undefined) intervals.push(conjunction);
  }
  if (alternatives === 0) return undefined;
  return { intervals };
}

/** What two declared ranges can be to each other. */
export type RangeCompatibility =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'unparsable'; readonly range: string; readonly problem: string };

/**
 * Whether ONE version satisfies both ranges.
 *
 * `unparsable` is its own answer: a range this algebra cannot read is a range it never compared,
 * and the caller must refuse it rather than call it compatible.
 */
export function rangeCompatibility(left: string, right: string): RangeCompatibility {
  const a = parseVersionRange(left);
  if (a === undefined) {
    return {
      kind: 'unparsable',
      range: left,
      problem: 'is not a version range this guard can read',
    };
  }
  const b = parseVersionRange(right);
  if (b === undefined) {
    return {
      kind: 'unparsable',
      range: right,
      problem: 'is not a version range this guard can read',
    };
  }
  for (const first of a.intervals) {
    for (const second of b.intervals) {
      if (intervalsOverlap(first, second)) return { kind: 'compatible' };
    }
  }
  return { kind: 'incompatible' };
}
