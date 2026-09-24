#!/usr/bin/env bun
// Enforce, as a ratchet, that no shipped source builds a URL on `ultimate.dev`.
//
// `https://ultimate.dev/errors/<code>` answered HTTP 404 — host included — on every error the
// framework ever threw, and it shipped as the `docs:` line of roughly ninety error declarations
// plus a `docsFor(code)` helper in four packages. `ERROR_DOCS_URL` in `@ultimat3/core` is the one
// answer now, and `UltimateError`'s constructor resolves it from the registered descriptor, so a
// declaration needs no `docs:` line at all.
//
// WHY A GATE AND NOT A SWEEP. The sweep is done and nothing stopped it regrowing:
// `scripts/new-package.ts` wrote the dead URL into EVERY future package's `errors.ts` template, and
// two gate scripts — `scripts/verify.ts` and `scripts/roadmap.ts` — still emitted it at the exact
// moment an agent's build failed. Both are fixed; this is what keeps them fixed.
//
// A COMMENT IS NOT A LINK. Twelve files name the host in prose as the thing that was REMOVED
// (`packages/core/src/error-codes.ts:26` and `packages/ai/src/errors.ts:71` set the precedent), and
// a comment cannot 404. Only an occurrence inside a STRING LITERAL — a value the process hands to
// an operator — is reported.
//
// ZERO-PINNED, and so it holds no pin table: the sweep finished before the rule landed, and a
// ratchet at zero is a rule that enforces outright. Adding a table back is a hand edit, in a
// review, whose question is "why is a 404 acceptable in the line an operator reads".
//
//   bun run dead-docs-host  ·  bun run scripts/dead-docs-host.ts [--json]

import type { SourceFile } from './boundaries';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import { isTestPath, lineOf } from './lib/source-scan';
import { insideString, sourceStrings } from './lib/source-strings';

const SCRIPT = 'dead-docs-host';

/**
 * The host, SPELT IN PIECES — because this file is shipped source and the rule reads shipped source,
 * so writing the literal here would make the rule its own first finding. Three occurrences in the
 * strings below did exactly that on the first run.
 */
export const HOST = ['ultimate', 'dev'].join('.');

/**
 * The dot is ESCAPED, and that is the whole reason this is a built pattern rather than a
 * `.includes`: an unescaped `.` matches `ultimate-dev-signing-secret`, a fixture value in this
 * tree, and a rule whose first finding is a false one is a rule nobody runs twice.
 */
export const DEAD_HOST = new RegExp(HOST.replace('.', '\\.'), 'g');

/** What replaces it, so the `fix:` names a symbol that exists rather than a URL to paste. */
export const REPLACEMENT = 'ERROR_DOCS_URL';

export interface DeadHostSite {
  readonly path: string;
  readonly line: number;
}

/** Every occurrence the process could actually emit — a string literal, never a comment. */
export function scanDeadHost(path: string, source: string): readonly DeadHostSite[] {
  const literals = sourceStrings(source);
  const out: DeadHostSite[] = [];
  for (const match of source.matchAll(DEAD_HOST)) {
    if (!insideString(literals, match.index)) continue;
    out.push({ path, line: lineOf(source, match.index) });
  }
  return out;
}

/**
 * A link a reader can CLICK, in a page or a YAML file: a markdown link target `](…)` or autolink
 * `<…>`, and any YAML value outside a `#` comment. A code span naming the host as the thing that
 * was removed is history, not a link — the same carve-out a source comment gets.
 */
export function scanDeadHostDoc(path: string, text: string): readonly DeadHostSite[] {
  const yaml = /\.ya?ml$/.test(path);
  const out: DeadHostSite[] = [];
  text.split('\n').forEach((line, index) => {
    const code = yaml ? line.replace(/(^|\s)#.*$/, '') : line;
    const linked = yaml
      ? DEAD_HOST.test(code)
      : new RegExp(`(?:\\]\\(|<)https?://${DEAD_HOST.source}`).test(code);
    DEAD_HOST.lastIndex = 0;
    if (linked) out.push({ path, line: index + 1 });
  });
  return out;
}

/** Every page and YAML file a reader or a workflow reads; dated records are not current links. */
const DOC_GLOBS = ['**/*.{md,yaml,yml}', '.github/**/*.{md,yaml,yml}'] as const;
const NOT_CURRENT = /(?:^|\/)node_modules\/|^docs\/plans\/|^CHANGELOG\.md$/;

export async function docSites(
  root: string,
): Promise<{ readonly sites: readonly DeadHostSite[]; readonly files: number }> {
  const paths = new Set<string>();
  for (const glob of DOC_GLOBS) {
    for (const path of new Bun.Glob(glob).scanSync({ cwd: root })) {
      if (!NOT_CURRENT.test(path)) paths.add(path);
    }
  }
  const sites: DeadHostSite[] = [];
  for (const path of [...paths].sort()) {
    sites.push(...scanDeadHostDoc(path, await Bun.file(`${root}/${path}`).text()));
  }
  return { sites, files: paths.size };
}

const isDoc = (path: string): boolean => /\.(?:md|ya?ml)$/.test(path);

export type DeadHostGap = RatchetGap<DeadHostSite>;

export interface DeadHostInput {
  readonly files: readonly SourceFile[];
  readonly pins: PinTable;
}

const shippedSites = (files: readonly SourceFile[]): readonly DeadHostSite[] =>
  files.flatMap((file) => (isTestPath(file.path) ? [] : scanDeadHost(file.path, file.source)));

/** The ratchet over fixture files; the tree itself is held at zero. */
export const checkDeadHost = (input: DeadHostInput): readonly DeadHostGap[] =>
  ratchetGaps(shippedSites(input.files), input.pins, input.files.length > 0);

const at = (site: DeadHostSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: DeadHostGap): Finding =>
  gap.first !== undefined && isDoc(gap.first.path) ? docFinding(gap) : codeFinding(gap);

const docFinding = (gap: DeadHostGap): Finding => ({
  code: 'X_DEAD_DOCS_HOST',
  cause: `${at(gap.first)} links to ${HOST}, a host that answers HTTP 404 on every path`,
  fix: `edit ${at(gap.first)} — link https://github.com/developerz-ai/ultimate/wiki/Error-Codes for an error, or https://github.com/developerz-ai/ultimate for the project`,
  at: at(gap.first),
});

const codeFinding = (gap: DeadHostGap): Finding => ({
  code: 'X_DEAD_DOCS_HOST',
  cause: `${gap.pkg} builds ${String(gap.found)} URL(s) on ${HOST} and is pinned at ${String(gap.pinned)} — ${at(gap.first)} emits one, and that host answers HTTP 404 on every path, so the link an operator is handed at the moment of a failure goes nowhere`,
  fix: `delete the docs: line at ${at(gap.first)} — UltimateError resolves the registered descriptor, whose default is ${REPLACEMENT} from @ultimat3/core; if this is not an error link, import ${REPLACEMENT} rather than writing a second host`,
  at: at(gap.first),
});

const staleFinding = (gap: DeadHostGap): Finding => ({
  code: 'X_DEAD_DOCS_HOST_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} ${HOST} URL(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `edit scripts/dead-docs-host.ts — the rule is zero-pinned and holds no table, so delete the pin for ${gap.pkg}`,
  at: 'scripts/dead-docs-host.ts',
});

const unscannedFinding = (): Finding => ({
  code: 'X_DEAD_DOCS_HOST_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no dead link in it',
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/dead-docs-host.ts',
  at: 'scripts/lib/corpus.ts',
});

export const deadHostFindingFor = (gap: DeadHostGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

export const deadHostSites = async (root: string): Promise<readonly DeadHostSite[]> => [
  ...shippedSites(await corpus(root, 'source')),
  ...(await docSites(root)).sites,
];

export const deadHostGaps = async (root: string): Promise<readonly DeadHostGap[]> =>
  ratchetGaps(await deadHostSites(root), {}, true);

/** What this rule contributes to `x verify`'s `unit` step, through `dead-docs-host.test.ts`. */
export const deadHostFindings = async (root: string): Promise<readonly Finding[]> =>
  (await deadHostGaps(root)).map(deadHostFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: 'scripts/dead-docs-host.ts',
    pins: {},
    sites: deadHostSites,
    findingFor: deadHostFindingFor,
    clean: `no shipped source builds, and no page or YAML file links, a URL on ${HOST}`,
  });
}
