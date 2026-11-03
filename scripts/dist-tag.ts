#!/usr/bin/env bun
// Print the npm dist-tag a release publishes under, read against what the registry's `latest`
// names now. `.github/workflows/release.yml` passes it to `npm publish --tag`, so a maintenance
// release of an older major never moves `latest` (wiki/Stability.md).
//
//   bun run scripts/dist-tag.ts --version 29.4.1 [--json]     (--json: the tag is .data.tag)

// why: the LEAF modules, never the `@ultimat3/cli` barrel, as registry-audit.ts imports them.
import { quoteArg } from '../packages/cli/src/shell-quote';
import { SEMVER } from '../packages/cli/src/workspace-checks';
import { flagString, parseScriptArgs } from './lib/args';
import { distTagFor } from './lib/dist-tag';
import type { ScriptResult } from './lib/log';
import { report } from './lib/log';
import {
  defaultFetch,
  lookup,
  packumentUrl,
  REQUEST_TIMEOUT_MS,
  type RegistryFetch,
} from './registry-audit';

export { distTagFor, maintTag, servingTag } from './lib/dist-tag';

const SCRIPT = 'dist-tag';
/** Tier 0 and in every lockstep release: its `latest` is the release's `latest`. */
export const TAG_SOURCE = '@ultimat3/core';

export async function distTagResult(
  version: string,
  fetcher: RegistryFetch = defaultFetch,
): Promise<ScriptResult> {
  const found = await lookup(TAG_SOURCE, fetcher, REQUEST_TIMEOUT_MS);
  if (found.kind === 'unreachable') {
    return {
      ok: false,
      script: SCRIPT,
      summary: `no dist-tag: the registry did not answer for ${TAG_SOURCE}`,
      findings: [
        {
          code: 'X_REGISTRY_UNREACHABLE',
          cause: `the registry did not answer for ${TAG_SOURCE}: ${found.detail}, and a guessed tag can move latest to an older major for good`,
          fix: `curl -sS -o /dev/null -w '%{http_code}\\n' ${quoteArg(packumentUrl(TAG_SOURCE))}   # then re-run: bun run scripts/dist-tag.ts --version ${version} --json`,
          at: TAG_SOURCE,
        },
      ],
    };
  }
  const tag = found.kind === 'found' ? found.packument['dist-tags']?.['latest'] : undefined;
  const latest = typeof tag === 'string' ? tag : undefined;
  const read = distTagFor(version, latest);
  if ('finding' in read) {
    return { ok: false, script: SCRIPT, summary: 'no dist-tag', findings: [read.finding] };
  }
  return {
    ok: true,
    script: SCRIPT,
    summary: `${version} publishes under ${read.tag}${latest === undefined ? '' : ` (latest is ${latest})`}`,
    lines: [read.tag],
    data: { version, ...(latest === undefined ? {} : { latest }), tag: read.tag },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const version = flagString(args, 'version');
  if (version === undefined || !SEMVER.test(version)) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: 'no dist-tag: --version is not a semver version',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: '--version must be the semver version about to be published (e.g. 29.4.1)',
            fix: 'bun run scripts/dist-tag.ts --version 29.4.1 --json',
            at: 'scripts/dist-tag.ts',
          },
        ],
      },
      args.json,
    );
  }
  report(await distTagResult(version), args.json);
}
