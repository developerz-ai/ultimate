// The error contract, enforced (axiom 3: a convention that is not a build error does not exist).
// Axiom 4 says an error is an instruction, so a `fix:` an agent cannot act on is a defect in the
// error, not a matter of taste — and a code no reference page documents strands whoever hits it.
// Both halves are decidable before the code runs, which is why they are a gate step and not a
// runtime assertion nobody sees until the failure they describe has already happened.

// `join` is `node:`-only by necessity: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { docsFor } from './errors';
import type { Finding } from './output';
import { eachSourceFile, isGenerated, isTest } from './source-files';
import type { FixSite } from './ts-scan';
import { scanCodes, scanFixes } from './ts-scan';

/** Advice, not instruction. The list is the one in `docs/architecture/04-error-contract.md`. */
export const BANNED_PHRASES: readonly RegExp[] = [
  /\bcheck(s|ed|ing)?\b/i,
  /\bmake sure\b/i,
  /\btry(ing)?\b/i,
  /\bsee the docs?\b/i,
];

/**
 * What makes a fix actionable as written: the `x` CLI, a tool the machine already has, a call the
 * reader can paste, or a file they can open. A banned phrase is only a failure without one of
 * these — "check the gateway, then: x actions describe posts.publish --json" names the observation
 * *and* the command, which is the shape the contract wants.
 */
export const COMMAND_TOKENS: readonly RegExp[] = [
  /(?:^|[\s;|&("'`])x\s+[a-z][a-z-]*/,
  /\b(?:bun|bunx|npm|npx|node|git|docker|kubectl|helm|psql|curl|openssl|biome|tsc)\b/,
  /\b[A-Za-z_$][\w$]*\(/,
  /[\w.@-]*\/[\w.@-]+\.(?:ts|tsx|js|json|md|toml|yaml|yml|css|scss|sql)\b/,
  /\b(?:app\.config\.ts|package\.json|tsconfig\.json|bunfig\.toml|\.env(?:\.[\w.-]+)?)\b/,
];

/**
 * `${…}` holds a value only the throw site knows, so it is blanked before the rule runs. Without
 * this, `check egress to ${new URL(url).host}` reads as a call expression and passes as a command
 * — the interpolation would launder pure advice into an instruction.
 */
export const staticFix = (raw: string): string => raw.replaceAll(/\$\{[^}]*\}/g, '<value>');

/** The rule, on one fix line. `undefined` means it holds. */
export function fixProblem(raw: string): string | undefined {
  const fix = staticFix(raw);
  if (fix.trim() === '') return 'the fix line is empty';
  const banned = BANNED_PHRASES.find((phrase) => phrase.test(fix));
  if (banned === undefined) return undefined;
  if (COMMAND_TOKENS.some((token) => token.test(fix))) return undefined;
  return `fix "${fix}" says "${fix.match(banned)?.[0] ?? ''}" and names no command, call or file`;
}

const fixFinding = (site: FixSite, problem: string): Finding => ({
  code: 'X_ERROR_FIX_INVALID',
  cause: problem,
  fix: `rewrite the fix at ${site.at}:${site.line} as a command to run, a call to paste, or an edit naming a file`,
  docs: docsFor('X_ERROR_FIX_INVALID'),
  at: `${site.at}:${site.line}`,
});

/** Every `fix:` an agent can be handed, read out of shipped source and held to the rule. */
export async function checkErrorFixes(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path)) continue;
    for (const site of scanFixes(await Bun.file(join(root, path)).text(), path)) {
      const problem = fixProblem(site.fix);
      if (problem !== undefined) findings.push(fixFinding(site, problem));
    }
  }
  return findings;
}

/**
 * A code is documented when the reference page names it. Deliberately not "owns a table row": the
 * page legitimately groups near-identical codes onto one row, and a rule that forbade that would
 * be a rule about formatting rather than about coverage.
 */
export const documentedCodes = (markdown: string): ReadonlySet<string> =>
  new Set([...markdown.matchAll(/`(X_[A-Z0-9_]+)`/g)].map((match) => match[1] as string));

const undocumentedFinding = (code: string, at: string, line: number, page: string): Finding => ({
  code: 'X_ERROR_CODE_UNDOCUMENTED',
  cause: `${code} is declared at ${at}:${line} and ${page} has no entry for it`,
  fix: `add a row for ${code} to ${page}, with its cause and the command that fixes it`,
  docs: docsFor('X_ERROR_CODE_UNDOCUMENTED'),
  at: page,
});

/**
 * The heading below which the reference stops making live claims. What follows is a code that is
 * reserved (documented, nothing throws it yet) or a superseded name kept so an old log line still
 * resolves. Both earn their rows; neither is a code an agent can be handed today, which is the
 * only thing the registry rule below is about.
 */
export const RESERVED_HEADING = '## Reserved codes';

/** The codes the reference presents as live: every one named above the reserved section. */
export function liveCodes(markdown: string): ReadonlySet<string> {
  const cut = markdown.indexOf(RESERVED_HEADING);
  return documentedCodes(cut === -1 ? markdown : markdown.slice(0, cut));
}

const unregisteredFinding = (code: string, page: string): Finding => ({
  code: 'X_ERROR_CODE_UNREGISTERED',
  cause: `${page} documents ${code} as a live code and nothing registers it, so "x errors explain ${code}" refuses a code this page promises`,
  fix: `register ${code} through registerErrorCodes() in its package's src/errors.ts, or move its row under "${RESERVED_HEADING}" in ${page}`,
  docs: docsFor('X_ERROR_CODE_UNREGISTERED'),
  at: page,
});

/**
 * The other direction of the same contract, and the half nothing enforced: a code the reference
 * documents that no package registers. `X_ERROR_CODE_UNDOCUMENTED` stops a shipped code losing its
 * page; this stops a page inventing a code — a row an agent reads, acts on, and then cannot look
 * up, because `x errors explain` answers from the registry and the registry never heard of it.
 *
 * `known` is what the host can answer for: the process-wide registry, plus whatever codes the host
 * repo's own gate scripts declare (`X_ROADMAP_*` and friends never ship, so no package may own
 * them). A missing page is `checkErrorCodeDocs`'s finding to report, not a second copy here.
 */
export async function checkErrorCodeRegistry(
  root: string,
  page: string,
  known: ReadonlySet<string>,
): Promise<readonly Finding[]> {
  const reference = Bun.file(join(root, page));
  if (!(await reference.exists())) return [];
  return [...liveCodes(await reference.text())]
    .filter((code) => !known.has(code))
    .sort()
    .map((code) => unregisteredFinding(code, page));
}

/**
 * Every `X_*` code shipped source declares must appear on the repo's error reference. The page is
 * the host repo's to name — a framework monorepo publishes one, a generated app does not — which
 * is why this arrives through the same host-check seam the tier table uses on `boundaries`.
 */
export async function checkErrorCodeDocs(root: string, page: string): Promise<readonly Finding[]> {
  const reference = Bun.file(join(root, page));
  if (!(await reference.exists())) {
    return [
      {
        code: 'X_ERROR_CODE_UNDOCUMENTED',
        cause: `the error reference ${page} does not exist, so no code can be documented`,
        fix: `create ${page} with a row per X_* code, or stop naming it as the error reference`,
        docs: docsFor('X_ERROR_CODE_UNDOCUMENTED'),
        at: page,
      },
    ];
  }
  const documented = documentedCodes(await reference.text());
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for await (const source of eachSourceFile(root)) {
    if (isTest(source) || isGenerated(source)) continue;
    for (const site of scanCodes(await Bun.file(join(root, source)).text(), source)) {
      if (documented.has(site.code) || seen.has(site.code)) continue;
      seen.add(site.code);
      findings.push(undocumentedFinding(site.code, site.at, site.line, page));
    }
  }
  return findings;
}
