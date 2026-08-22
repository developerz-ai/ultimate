#!/usr/bin/env bun
// Enforce, as a gate step, that documentation citing an `app.config.ts` key names a key that
// EXISTS. `doc-fixes.ts` resolves the other half of the same sentence — `x <command>` — against the
// command registry, so `fix: x db query …` fails while `fix: set jobs.driver = 'pg' in
// app.config.ts` passed, and `jobs.driver` was deleted in 5.0.0 for having no reader at all.
//
// The worked example of axiom 4, in the page that DEFINES axiom 4, demonstrated it with a no-op.
//
// WHAT COUNTS AS A CITATION, and it is deliberately narrow: a dotted `<section>.<key>` on a line
// that also names `app.config.ts` or `defineConfig`. Without that anchor the scan reports
// `auth.adapter.putApiKey(record)`, `auth.limiter.recordSuccess('<key>')` and `auth.sessions.policy`
// — properties of a runtime object that merely share a section's name — and a check whose findings
// have to be argued with is a check an agent learns to skip. The cost is a citation with no anchor
// (`docs/idea/17-scale-ladder.md`'s ladder table spells `jobs.driver: 'postgres'` in a config
// column and names no file), which this rule does not see and says so.
//
//   bun run scripts/doc-config-keys.ts [--json]

import { CONFIG_FILE, configLeaves } from './config-readers';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/**
 * The published pages. `docs/plans/**` is excluded on purpose: a plan describes the key it is about
 * to delete, so a working document citing a dead key is the document doing its job.
 */
export const DOC_GLOBS = ['docs/**/*.md', 'wiki/**/*.md'] as const;
const EXCLUDED = /^docs\/plans\//;

/** The anchor that makes a dotted token a CONFIG citation rather than a property access. */
const ANCHOR = /app\.config\.ts|defineConfig/;

/**
 * A line that names a key in order to say it is GONE. The wiki's whole job at `Known-Gaps.md:80`,
 * `Configuration.md:297` and `Jobs-And-Workflows.md:186` is to record that `jobs.driver`,
 * `ai.modelEnv` and `realtime.heartbeatMs` were deleted — reporting those as citations would tell a
 * writer to stop documenting a removal, which is the opposite of what this rule wants.
 *
 * Each alternative is anchored to a phrase and not to a bare `not`: `docs/architecture/04-error-contract.md:168`
 * reads "`this is not supported` | `set jobs.driver = 'pg' in app.config.ts`", so a broad negation
 * test suppresses the one finding this rule exists for.
 */
const NEGATED =
  /no reader|nothing reads|\bdeleted\b|\bremoved\b|~~|never\s+(?:read|were|was)|there\s+(?:is|are)\s+no\b|(?:is|are|was|were|\bnot)\s+(?:not\s+)?(?:an?|the)?\s*\W{0,3}app\.config\.ts\W{0,3}\s*(?:key|field)/i;

/** A path, not a key: `packages/auth/src/auth.ts` ends in a file extension and starts after a `/`. */
const FILE_EXTENSION = /\.(?:ts|tsx|js|json|md|scss|css|yml|yaml|toml|sql)$/;

export interface ConfigCitation {
  readonly path: string;
  readonly line: number;
  readonly cited: string;
}

/**
 * Every `<section>.<key>` on an anchored line, where `<section>` is a real top-level section of
 * `AppConfig`. Anchoring on the SECTION set rather than on "any dotted word" is what keeps
 * `x.manifest.json` and `package.json` out of the answer.
 */
export function configCitations(
  path: string,
  markdown: string,
  leaves: readonly string[],
): readonly ConfigCitation[] {
  const sections = [...new Set(leaves.map((leaf) => leaf.split('.')[0] as string))];
  // The lookbehind is what keeps `packages/auth/src/auth.ts` out: `auth` is a section, `.ts` looks
  // like a key, and the whole token is a file path inside a documentation link.
  const token = new RegExp(`(?<![\\w$/.-])(${sections.join('|')})((?:\\.[A-Za-z][\\w$]*)+)`, 'g');
  const found: ConfigCitation[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!ANCHOR.test(line) || NEGATED.test(line)) continue;
    for (const match of line.matchAll(token)) {
      if (FILE_EXTENSION.test(match[0])) continue;
      found.push({ path, line: index + 1, cited: match[0] });
    }
  }
  return found;
}

/**
 * A citation is satisfied by a leaf or by any PREFIX of one: `cache.tiers` is a leaf, `ai.mcp` is
 * the section a leaf sits in, and both name something an author can write. Anything else names
 * nothing — which is the finding.
 */
export const isKnownKey = (cited: string, leaves: readonly string[]): boolean =>
  leaves.some((leaf) => leaf === cited || leaf.startsWith(`${cited}.`));

export const configKeyFindingFor = (citation: ConfigCitation): Finding => ({
  code: 'X_DOC_CONFIG_KEY_UNKNOWN',
  cause: `${citation.path}:${String(citation.line)} tells a reader to set ${citation.cited} in app.config.ts and ${CONFIG_FILE} declares no such key — the instruction type-errors in the app it is pasted into`,
  fix: `name a key AppConfig declares at ${citation.path}:${String(citation.line)} — read the current set with bun run scripts/config-readers.ts --json`,
  at: `${citation.path}:${String(citation.line)}`,
});

/** Every published page that cites a key `AppConfig` does not declare. */
export async function unknownConfigKeys(root: string): Promise<readonly ConfigCitation[]> {
  const leaves = configLeaves(await Bun.file(`${root}/${CONFIG_FILE}`).text());
  const found: ConfigCitation[] = [];
  for (const glob of DOC_GLOBS) {
    for (const entry of new Bun.Glob(glob).scanSync({ cwd: root })) {
      const path = entry.split('\\').join('/');
      if (EXCLUDED.test(path)) continue;
      const citations = configCitations(path, await Bun.file(`${root}/${path}`).text(), leaves);
      found.push(...citations.filter((citation) => !isKnownKey(citation.cited, leaves)));
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

/** What this rule contributes to `x verify`'s `errors` step, through `docFixFindings`. */
export const docConfigKeyFindings = async (root: string): Promise<readonly Finding[]> =>
  (await unknownConfigKeys(root)).map(configKeyFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unknown = await unknownConfigKeys(root);
  report(
    {
      ok: unknown.length === 0,
      script: 'doc-config-keys',
      summary:
        unknown.length === 0
          ? 'every app.config.ts key cited by the docs is one AppConfig declares'
          : `${String(unknown.length)} documented app.config.ts key(s) do not exist`,
      findings: unknown.map(configKeyFindingFor),
    },
    args.json,
  );
}
