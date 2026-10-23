#!/usr/bin/env bun
// Read whether the release tag `v<version>` is on `origin`, in the one shape every consumer of that
// fact already reads: the `TagProbe` answer `scripts/registry-audit.ts` asks for. PUBLISHING.md's
// "the tag is on the remote" row was a raw `git ls-remote`, so a caller had to know
// that `--exit-code` answers 0 for a match, 2 for none and anything else is NO answer — and a
// caller who read that as "absent" would conclude a release never ran.
//
// This answers EXISTENCE only. An annotated tag is a separate fact — a lightweight one is on
// origin too, and only the peeled `refs/tags/v<version>^{}` ref distinguishes them — so the
// row PUBLISHING.md carries for it is its own `git ls-remote`. Widening this probe to mean
// "annotated" would silently narrow `registry-audit`'s dispatch gate, which only needs the ref.
//
// Read-only, one version, no flags beyond `--json`. A probe that could not answer reports
// `ok: false` with the finding and never a `false` onOrigin, because "git did not say" and "origin
// does not hold it" are different facts about a release.
//
//   bun run scripts/tag-on-origin.ts 26.1.1 --json

import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { remoteTagProbe } from './registry-audit';

const SCRIPT = 'tag-on-origin';

/** Only a version this repo would stamp; anything else is a typo, refused rather than probed. */
const VERSION = /^\d+\.\d+\.\d+$/;

const refused = (cause: string, fix: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary: 'refused',
  findings: [{ code: 'X_CLI_BAD_FLAG', cause, fix, at: 'scripts/tag-on-origin.ts' }],
});

const unreadableFix = (tag: string): string =>
  'git ls-remote --exit-code --tags origin refs/tags/' +
  tag +
  ' && bun run scripts/tag-on-origin.ts <version> --json';

const unreadable = (tag: string): Finding => ({
  code: 'X_REGISTRY_UNREACHABLE',
  cause: `git could not read ${tag} from origin, so whether it is there is unknown — this is not evidence that the tag was never pushed, then re-run the script to confirm`,
  fix: unreadableFix(tag),
  at: 'scripts/tag-on-origin.ts',
});

/**
 * `onOrigin: null` is the third answer, and it is why the finding exists: `true`/`false` are what
 * `git ls-remote --exit-code` can say, and every other exit code is git declining to.
 */
export async function tagOnOrigin(
  version: string,
  probe = remoteTagProbe(repoRoot()),
): Promise<ScriptResult> {
  const tag = `v${version}`;
  const onOrigin = await probe(tag);
  if (onOrigin === undefined) {
    return {
      ok: false,
      script: SCRIPT,
      summary: `git could not answer whether ${tag} is on origin`,
      findings: [unreadable(tag)],
      data: { tag, onOrigin: null },
    };
  }
  return {
    ok: true,
    script: SCRIPT,
    summary: onOrigin ? `${tag} is on origin` : `${tag} is not on origin`,
    lines: [`  ${tag}  ${onOrigin ? 'on origin' : 'not on origin'}`],
    data: { tag, onOrigin },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const version = args.positionals[0];
  report(
    version === undefined || !VERSION.test(version)
      ? refused(
          version === undefined
            ? 'no version given, so there is no tag to read from origin'
            : `"${version}" is not a version this repo stamps — expected digits, a dot, digits, a dot, digits, and no leading v`,
          'bun run scripts/tag-on-origin.ts 26.1.1 --json',
        )
      : await tagOnOrigin(version),
    args.json,
  );
}
