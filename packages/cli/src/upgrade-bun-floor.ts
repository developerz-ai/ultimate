// The Bun floor, as a plain text edit per pin site: `engines.bun`, `.bun-version`, `packageManager`,
// `setup-bun`, `oven/bun:` tags. Pure over one file's text. Text and not a parse, because the rest of
// the file is the author's to the byte. A site is only ever raised; one this cannot read is listed.

// why: Bun exposes no basename primitive.
import { basename } from 'node:path';

export interface BunEdit {
  readonly path: string;
  readonly site: string;
  readonly from: string;
  readonly to: string;
}

/** A site only its author can move, with the line to open and why. */
export interface BunManual {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

export interface BunFileEdit {
  readonly text: string;
  readonly edited: readonly BunEdit[];
  readonly manual: readonly BunManual[];
}

const DOCKERFILE = /^(?:Dockerfile(?:\..+)?|.+\.[Dd]ockerfile)$/;
const YAML = /\.ya?ml$/;
const VERSION_TEXT = /\d+\.\d+(?:\.\d+)?/;

const isPackageManifest = (name: string): boolean => name === 'package.json';

/** Whether a tracked path can hold a pin site at all. */
export const isBunSite = (path: string): boolean => {
  const name = basename(path);
  return (
    name === '.bun-version' || isPackageManifest(name) || YAML.test(name) || DOCKERFILE.test(name)
  );
};

/** The version in an `engines.bun` range, or undefined for one that names none. */
export const floorOf = (range: string | undefined): string | undefined =>
  range === undefined ? undefined : VERSION_TEXT.exec(range)?.[0];

const numbers = (version: string): readonly number[] => version.split('.').map(Number);

/** Below the floor, read at the version's own precision: `1.4` floats, so it reaches `1.4.4`. */
const isBelow = (version: string, floor: string): boolean => {
  const held = numbers(version);
  const wanted = numbers(floor);
  for (let at = 0; at < held.length; at += 1) {
    const left = held[at] ?? 0;
    const right = wanted[at] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
};

/** The floor at the version's precision, so `1.3-alpine` becomes `1.4-alpine` and still floats. */
const atPrecision = (version: string, floor: string): string =>
  floor.split('.').slice(0, version.split('.').length).join('.');

/** A range's version is its lower bound, never a floating tag: `>=1.4` admits 1.4.0. */
const lowerBound = (version: string): string =>
  [...version.split('.'), '0', '0'].slice(0, 3).join('.');

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

/** One comparator over one version: the only range a raise cannot turn into a different claim. */
const PLAIN_RANGE = /^(?:>=|\^|~)?\s*\d+\.\d+(?:\.\d+)?$/;
const EXACT = /^\d+\.\d+\.\d+$/;

const BY_HAND = (floor: string): string =>
  `this spelling cannot be raised by a text edit: set it to Bun ${floor} or above`;

const editManifest = (path: string, source: string, floor: string): BunFileEdit => {
  const edited: BunEdit[] = [];
  const manual: BunManual[] = [];
  const listed = (offset: number, text: string): void => {
    manual.push({ path, line: lineAt(source, offset), text, why: BY_HAND(floor) });
  };
  let text = source.replace(
    /("engines"\s*:\s*\{[^}]*?"bun"\s*:\s*")([^"]*)(")/,
    (whole, head: string, range: string, tail: string, offset: number) => {
      const version = floorOf(range);
      if (version === undefined || !isBelow(lowerBound(version), floor)) return whole;
      if (!PLAIN_RANGE.test(range)) {
        listed(offset + head.length, `"bun": "${range}"`);
        return whole;
      }
      const to = range.replace(version, floor);
      edited.push({ path, site: 'engines.bun', from: range, to });
      return `${head}${to}${tail}`;
    },
  );
  // Offsets into `source`: the `engines` edit above can only move a later offset by a few bytes, and
  // never across a line.
  text = text.replace(
    /("packageManager"\s*:\s*"bun@)([^"]*)(")/,
    (whole, head: string, value: string, tail: string, offset: number) => {
      const version = floorOf(value);
      if (version === undefined || !isBelow(version, floor)) return whole;
      if (!EXACT.test(value)) {
        listed(offset + head.length, `"packageManager": "bun@${value}"`);
        return whole;
      }
      edited.push({ path, site: 'packageManager', from: value, to: floor });
      return `${head}${floor}${tail}`;
    },
  );
  return { text, edited, manual };
};

const editVersionFile = (path: string, source: string, floor: string): BunFileEdit => {
  const value = source.trim();
  const version = floorOf(value);
  if (version === undefined || !isBelow(version, floor)) {
    return { text: source, edited: [], manual: [] };
  }
  if (!EXACT.test(value)) {
    return {
      text: source,
      edited: [],
      manual: [{ path, line: 1, text: value, why: BY_HAND(floor) }],
    };
  }
  return {
    text: source.replace(value, floor),
    edited: [{ path, site: '.bun-version', from: value, to: floor }],
    manual: [],
  };
};

const BUN_VERSION_KEY = /^(\s*(?:-\s*)?bun-version:\s*)(['"]?)([^'"\s#][^'"#]*?)\2(\s*(?:#.*)?)$/;
const IMAGE = /oven\/bun:([^\s'"@]+)(@sha256:[0-9a-f]+)?/;
/** A suffix is a Docker variant (`-alpine`): `1.3.x` is no version with a suffix. */
const TAG = /^(\d+\.\d+(?:\.\d+)?)(-.*)?$/;

/** One line of a YAML file or Dockerfile: the edited text, and what it had to report. */
function editLine(input: {
  readonly path: string;
  readonly line: string;
  readonly number: number;
  readonly floor: string;
  readonly edited: BunEdit[];
  readonly manual: BunManual[];
}): string {
  const { path, line, number, floor, edited, manual } = input;
  // Prose: a Dockerfile's header names the digest it pins, and rewriting that lies about the file.
  if (line.trimStart().startsWith('#')) return line;
  const listed = (why: string): string => {
    manual.push({ path, line: number, text: line.trim(), why });
    return line;
  };
  const belowInSomeSpelling = (value: string): boolean => {
    const version = floorOf(value);
    return version !== undefined && isBelow(version, floor);
  };

  const key = BUN_VERSION_KEY.exec(line);
  if (key !== null) {
    const [, head = '', quote = '', value = '', tail = ''] = key;
    if (value.includes('$')) {
      return listed('the version is an expression: edit where it is defined');
    }
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) {
      return belowInSomeSpelling(value) ? listed(BY_HAND(floor)) : line;
    }
    if (!isBelow(value, floor)) return line;
    const to = atPrecision(value, floor);
    edited.push({ path, site: 'setup-bun', from: value, to });
    return `${head}${quote}${to}${quote}${tail}`;
  }

  const image = IMAGE.exec(line);
  if (image === null) return line;
  const [whole, tag = '', digest] = image;
  if (tag.includes('$')) return listed('the tag is a variable: edit where it is defined');
  const parts = TAG.exec(tag);
  const version = parts?.[1];
  if (digest !== undefined) {
    const inspect = `by hand (docker buildx imagetools inspect oven/bun:${floor}-alpine)`;
    if (version === undefined || isBelow(version, floor)) {
      return listed(
        `a digest pins this image: move the tag and digest together to oven/bun:${floor}'s, ${inspect}`,
      );
    }
    // `1.4-alpine@sha256:…` at a 1.4.4 floor: the tag reaches it and the digest may not, and which
    // patch a digest holds is not on this line. `1.4.4-alpine@…` and `1.5-alpine@…` say enough.
    return version === atPrecision(version, floor) && version.split('.').length < 3
      ? listed(
          `a digest pins a floating tag, so its patch cannot be read here: confirm it is ${floor} or above, ${inspect}`,
        )
      : line;
  }
  if (version === undefined) return belowInSomeSpelling(tag) ? listed(BY_HAND(floor)) : line;
  if (!isBelow(version, floor)) return line;
  const to = atPrecision(version, floor);
  const suffix = parts?.[2] ?? '';
  edited.push({ path, site: 'oven/bun', from: tag, to: `${to}${suffix}` });
  return line.replace(whole, `oven/bun:${to}${suffix}`);
}

const editLines = (path: string, source: string, floor: string): BunFileEdit => {
  const edited: BunEdit[] = [];
  const manual: BunManual[] = [];
  // Split on `\n` alone, so a CRLF file's `\r` goes through its line untouched — except that a `$`
  // anchor needs it gone, so it is lifted off and put back.
  const lines = source.split('\n').map((raw, index) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr === '' ? raw : raw.slice(0, -1);
    return `${editLine({ path, line, number: index + 1, floor, edited, manual })}${cr}`;
  });
  return { text: lines.join('\n'), edited, manual };
};

/** One file's sites raised to `floor`. Run twice, the second run changes nothing. */
export function editBunSites(path: string, source: string, floor: string): BunFileEdit {
  const name = basename(path);
  if (name === '.bun-version') return editVersionFile(path, source, floor);
  if (isPackageManifest(name)) return editManifest(path, source, floor);
  return editLines(path, source, floor);
}
