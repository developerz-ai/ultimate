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
import type { DocConfigKeyAllowance } from './lib/doc-config-key-pins';
import { DOC_CONFIG_KEY_ALLOWANCES, DOC_CONFIG_PINS_FILE } from './lib/doc-config-key-pins';
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
 * The imperative shape, and the one an agent pastes: `set http.rateLimit.scope: 'process' in
 * app.config.ts`. It takes ANY dotted identifier, because `set …` is what removes the ambiguity the
 * section anchor below exists for — nothing reads "set `auth.adapter.putApiKey(record)`". Without
 * it an unknown top-level SECTION was invisible: `sections.join('|')` can only match a section that
 * exists, so `set billing.currency in app.config.ts` matched nothing, `isKnownKey` was never asked,
 * and the gate reported green over a section `AppConfig` has never declared. Measured on this tree
 * the day it landed: four citations of `http.*`, a section that does not exist.
 */
const SET_FORM = /\bset\s+`?([A-Za-z][\w$]*(?:\.[A-Za-z][\w$]*)+)/g;

/**
 * Every `<section>.<key>` on an anchored line, where `<section>` is a real top-level section of
 * `AppConfig`, plus every `set <dotted>` on one whatever its section. Anchoring the general case on
 * the SECTION set rather than on "any dotted word" is what keeps `x.manifest.json` and
 * `package.json` out of the answer; `SET_FORM` is what keeps an unknown section from being invisible.
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
    // One finding per line per key: the two matchers overlap on every citation whose section does
    // exist, and two identical findings read as two defects.
    const seen = new Set<string>();
    for (const match of [...line.matchAll(token)].map((one) => one[0] as string)) {
      if (FILE_EXTENSION.test(match) || seen.has(match)) continue;
      seen.add(match);
      found.push({ path, line: index + 1, cited: match });
    }
    for (const match of [...line.matchAll(SET_FORM)].map((one) => one[1] as string)) {
      if (FILE_EXTENSION.test(match) || seen.has(match)) continue;
      seen.add(match);
      found.push({ path, line: index + 1, cited: match });
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
  fix: `name a key AppConfig declares at ${citation.path}:${String(citation.line)} — read the current set with bun run scripts/config-readers.ts --json — or record a deliberate citation as { path, cites, why } in DOC_CONFIG_KEY_ALLOWANCES in ${DOC_CONFIG_PINS_FILE}`,
  at: `${citation.path}:${String(citation.line)}`,
});

/** The allowance list's own hygiene: an entry matching nothing is a waiver nobody reads. */
export const staleAllowanceFindingFor = (allowance: DocConfigKeyAllowance): Finding => ({
  code: 'X_DOC_CONFIG_ALLOWANCE_STALE',
  cause: `${DOC_CONFIG_PINS_FILE} allows ${allowance.path} to cite ${allowance.cites} and that page no longer does — a waiver nobody removes is a waiver nobody reads`,
  fix: `delete the { path: '${allowance.path}', cites: '${allowance.cites}' } entry from DOC_CONFIG_KEY_ALLOWANCES in ${DOC_CONFIG_PINS_FILE}`,
  at: DOC_CONFIG_PINS_FILE,
});

export interface ConfigKeyReport {
  /** Cited, unknown, and not allowed. */
  readonly unknown: readonly ConfigCitation[];
  /** Allowed, and matching no citation on the page it names. */
  readonly staleAllowances: readonly DocConfigKeyAllowance[];
}

/** Every published page that cites a key `AppConfig` does not declare, minus the recorded ones. */
export async function unknownConfigKeys(
  root: string,
  allow: readonly DocConfigKeyAllowance[] = DOC_CONFIG_KEY_ALLOWANCES,
): Promise<ConfigKeyReport> {
  const leaves = configLeaves(await Bun.file(`${root}/${CONFIG_FILE}`).text());
  const found: ConfigCitation[] = [];
  const used = new Set<DocConfigKeyAllowance>();
  for (const glob of DOC_GLOBS) {
    for (const entry of new Bun.Glob(glob).scanSync({ cwd: root })) {
      const path = entry.split('\\').join('/');
      if (EXCLUDED.test(path)) continue;
      const citations = configCitations(path, await Bun.file(`${root}/${path}`).text(), leaves);
      for (const citation of citations) {
        if (isKnownKey(citation.cited, leaves)) continue;
        const allowance = allow.find(
          (one) => one.path === citation.path && one.cites === citation.cited,
        );
        if (allowance !== undefined) {
          used.add(allowance);
          continue;
        }
        found.push(citation);
      }
    }
  }
  return {
    unknown: found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)),
    staleAllowances: allow.filter((one) => !used.has(one)),
  };
}

/** What this rule contributes to `x verify`'s `errors` step, through `docFixFindings`. */
export const docConfigKeyFindings = async (root: string): Promise<readonly Finding[]> => {
  const found = await unknownConfigKeys(root);
  return [
    ...found.unknown.map(configKeyFindingFor),
    ...found.staleAllowances.map(staleAllowanceFindingFor),
  ];
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const findings = await docConfigKeyFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: 'doc-config-keys',
      summary:
        findings.length === 0
          ? `every app.config.ts key cited by the docs is one AppConfig declares (${String(DOC_CONFIG_KEY_ALLOWANCES.length)} recorded exception(s), which may only shrink)`
          : `${String(findings.length)} documented app.config.ts key(s) do not exist`,
      findings,
    },
    args.json,
  );
}
