// The version a release publishes, decided and never guessed: the bump and `--version` flags,
// refused before a manifest is touched. Split out of `scripts/release.ts` at the size ceiling;
// that script re-exports every name here, so its callers import from one module.

import { SEMVER } from '@ultimat3/cli';
import { unknownFlags } from './args';
import type { Finding } from './log';
import { compareReleaseVersions } from './release-preflight';

export const BUMPS = ['patch', 'minor', 'major'] as const;

export type Bump = (typeof BUMPS)[number];

/**
 * `--bump` was cast to the union with no check, so `--bump majr` fell through both branches of
 * `nextVersion` and produced a PATCH — a breaking change shipped as 1.2.1 across all 29 manifests,
 * with an exit code of 0. `--version` was equally unvalidated: `--version 1.2` wrote `"1.2"` into
 * every package.json.
 */
export const isBump = (value: string): value is Bump =>
  (BUMPS as readonly string[]).includes(value);

export const badFlagFinding = (flag: string, value: string, expected: string): Finding => ({
  code: 'X_CLI_BAD_FLAG',
  cause: `--${flag} ${value} is not ${expected}`,
  fix: `bun run scripts/release.ts --bump minor --dry-run --json`,
  at: 'scripts/release.ts',
});

/**
 * The flags this script accepts. Anything else is refused before a manifest is touched — see
 * `readReleaseVersion` for why an unrecognised token must never reach the rewrite.
 */
export const RELEASE_FLAGS = ['version', 'bump', 'check', 'dry-run', 'json', 'security'] as const;

/** Every `--flag` the caller passed that this script does not declare. */
export const unknownReleaseFlags = (flags: Iterable<string>): readonly string[] =>
  unknownFlags(flags, RELEASE_FLAGS);

/**
 * Both flags, refused before a single manifest is rewritten.
 *
 * The absent case is a REFUSAL, not a patch bump. It defaulted to `patch`, so any invocation the
 * parser did not recognise — `--help` most obviously, since this script has never had one — fell
 * through to "no explicit, no bump" and rewrote 47 manifests plus the chart. A release is the most
 * expensive thing in this repo to undo, and it was the one script that acted on a typo. The
 * version to publish is always somebody's decision, so it is always stated.
 */
export function readReleaseVersion(input: {
  readonly explicit: string | undefined;
  readonly bump: string | undefined;
  readonly current: string;
}): { version: string } | { findings: readonly Finding[] } {
  const findings: Finding[] = [];
  if (input.bump !== undefined && !isBump(input.bump)) {
    findings.push(badFlagFinding('bump', input.bump, `one of ${BUMPS.join(', ')}`));
  }
  if (input.explicit !== undefined && !SEMVER.test(input.explicit)) {
    findings.push(badFlagFinding('version', input.explicit, 'a semver version (e.g. 1.3.0)'));
  }
  if (input.explicit === undefined && input.bump === undefined) {
    findings.push({
      code: 'X_RELEASE_VERSION_UNSTATED',
      cause: `neither --version nor --bump was given, and this repo is at ${input.current}`,
      // It also offered `--version <current>`, which the forward-only rule below now refuses.
      fix: 'bun run scripts/release.ts --bump patch --dry-run --json',
      at: 'scripts/release.ts',
    });
  }
  if (findings.length > 0) return { findings };
  // Both given: `--bump` used to be read only when `--version` was absent, so one of two stated
  // intents was dropped without a word. Neither wins; the caller states one.
  if (input.explicit !== undefined && input.bump !== undefined) {
    findings.push(
      invalidVersionFinding(
        `--version ${input.explicit} and --bump ${input.bump} were both given, and they name two different ways to pick the version after ${input.current}`,
      ),
    );
  } else if (
    input.explicit !== undefined &&
    compareReleaseVersions(input.explicit, input.current) <= 0
  ) {
    // At or below the current version is a version npm already holds, or one below it: the
    // publish dies `E403` package by package, after the tag and the Release already exist.
    findings.push(
      invalidVersionFinding(
        `--version ${input.explicit} does not move forward: this repo is already at ${input.current}`,
      ),
    );
  } else if (input.explicit !== undefined && opensMajorOff(input.explicit, input.current)) {
    // A new major line opens at the next X.0.0 and nowhere else: `--version 31.1.0` from 30.x
    // would be a major the window and every reader of "X.0.0" missed (wiki/Stability.md).
    findings.push(
      invalidVersionFinding(
        `--version ${input.explicit} opens a new major line from ${input.current}, and a major opens at ${nextVersion(input.current, 'major')}`,
      ),
    );
  }
  if (findings.length > 0) return { findings };
  return {
    version: input.explicit ?? nextVersion(input.current, (input.bump ?? 'patch') as Bump),
  };
}

const invalidVersionFinding = (cause: string): Finding => ({
  code: 'X_RELEASE_VERSION_INVALID',
  cause,
  fix: 'bun run scripts/release.ts --bump patch --dry-run --json   # or --bump minor, --bump major',
  at: 'scripts/release.ts',
});

export function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] =
    current
      .split('-')[0]
      ?.split('.')
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const majorNumber = (version: string): number => Number.parseInt(version.split('.')[0] ?? '', 10);

/** `version` moves the major above `current`'s, and is not the very next `X.0.0`. */
const opensMajorOff = (version: string, current: string): boolean =>
  majorNumber(version) > majorNumber(current) &&
  version.split('-')[0] !== nextVersion(current, 'major');
