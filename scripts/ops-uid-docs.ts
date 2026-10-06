#!/usr/bin/env bun
// Enforce, as a gate rule, that every pod/process uid `docs/ops/` states is one of the two the tree
// actually runs, and the right one for the image it names: a scaffolded app's is `RUNTIME_UID`
// (`packages/cli/src/templates/scaffold-helm.ts`, read by its Dockerfile's `USER` and its chart),
// this repo's chart's is `docker/helm/values.yaml`'s `runAsUser`. The pages said the scaffold ran
// 1000 in both its Dockerfile and its chart while the chart ran 65532 — and an operator copying a
// uid out of a runbook gets a pod that `runAsNonRoot` refuses, or a volume it cannot write.
//
// READ PER CLAUSE. A sentence is cut at `;`, ` — `, `. `, `, where ` and table pipes, and a clause
// on a line stating a uid (`runAsUser`, `fsGroup`, `USER`, `uid`, `nonroot` …) is attributed by what it names:
// "this repo" / distroless → the repo's chart, `x new` / scaffold / `oven/bun` → `RUNTIME_UID`. A
// clause naming both, or neither, is held only to "one of the two". Dates, versions and sizes are
// not uids.
//
//   bun run scripts/ops-uid-docs.ts [--json]

import { RUNTIME_UID } from '../packages/cli/src/templates/scaffold-helm';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'ops-uid-docs';
export const OPS_GLOB = 'docs/ops/*.md';
export const REPO_VALUES = 'docker/helm/values.yaml';

export type UidOwner = 'repo' | 'scaffold' | 'either';

export interface UidClaim {
  readonly path: string;
  readonly line: number;
  readonly uid: number;
  readonly owner: UidOwner;
  readonly clause: string;
}

const CLAUSE_BREAK = /;|\s—\s|\.\s|,\s+where\s|\|/;
const UID_CONTEXT = /runAsUser|runAsGroup|fsGroup|\bUSER\s|\buid\b|\bgid\b|nonroot|pod identity/i;
const REPO_MARK = /this repo|distroless|the framework's (?:own )?image/i;
const SCAFFOLD_MARK = /x new|scaffold|oven\/bun|RUNTIME_UID/i;
/** A 3–6 digit integer that is not part of a date (`2026-10`), a version (`1.4`) or a size (`184 MB`). */
const NUMBER = /(?<![\w.-])(\d{3,6})(?![\w.%]|-\d|\s*(?:[KMGT]i?B|ms)\b)/gi;

/** The repo chart's `podSecurityContext.runAsUser`, or `undefined` when the file states none. */
export const repoChartUid = (valuesYaml: string): number | undefined => {
  const block = /^podSecurityContext:\s*\n((?:[ \t]+.*\n?)*)/m.exec(valuesYaml)?.[1] ?? '';
  const uid = /^\s+runAsUser:\s*(\d+)/m.exec(block)?.[1];
  return uid === undefined ? undefined : Number(uid);
};

const ownerOf = (clause: string): UidOwner => {
  const repo = REPO_MARK.test(clause);
  const scaffold = SCAFFOLD_MARK.test(clause);
  return repo === scaffold ? 'either' : repo ? 'repo' : 'scaffold';
};

/** Every uid a page states, outside fences, each with the image its clause attributes it to. */
export function uidClaims(path: string, markdown: string): readonly UidClaim[] {
  const claims: UidClaim[] = [];
  let fenced = false;
  markdown.split('\n').forEach((text, index) => {
    if (/^\s*(?:```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) return;
    // The LINE is the context, the CLAUSE the attribution: a table row names `runAsUser` in its
    // first cell and states the numbers in the next one.
    if (!UID_CONTEXT.test(text)) return;
    for (const clause of text.split(CLAUSE_BREAK)) {
      const owner = ownerOf(clause);
      for (const match of clause.matchAll(NUMBER)) {
        claims.push({ path, line: index + 1, uid: Number(match[1]), owner, clause: clause.trim() });
      }
    }
  });
  return claims;
}

export interface UidFacts {
  readonly scaffold: number;
  readonly repo: number;
}

/** Every claim that names a uid the tree does not run, or the other image's uid. Pure. */
export function checkUidClaims(claims: readonly UidClaim[], facts: UidFacts): readonly Finding[] {
  return claims.flatMap((claim): readonly Finding[] => {
    const at = `${claim.path}:${claim.line}`;
    const expected =
      claim.owner === 'repo'
        ? [facts.repo]
        : claim.owner === 'scaffold'
          ? [facts.scaffold]
          : [facts.repo, facts.scaffold];
    if (expected.includes(claim.uid)) return [];
    const which =
      claim.owner === 'repo'
        ? `this repo's chart runs ${facts.repo} (${REPO_VALUES})`
        : claim.owner === 'scaffold'
          ? `a scaffolded app runs RUNTIME_UID = ${facts.scaffold} (packages/cli/src/templates/scaffold-helm.ts)`
          : `the tree runs ${facts.scaffold} (RUNTIME_UID) and ${facts.repo} (${REPO_VALUES}) and nothing else`;
    return [
      {
        code: 'X_DOC_UID_STALE',
        cause: `${at} states uid ${claim.uid} in "${claim.clause.slice(0, 120)}", and ${which}`,
        fix: `bun run scripts/ops-uid-docs.ts --json   # then edit ${at} to state ${expected.join(' or ')}`,
        at,
      },
    ];
  });
}

export interface UidDocRead {
  readonly claims: readonly UidClaim[];
  readonly repo: number | undefined;
}

export async function readUidDocs(root: string): Promise<UidDocRead> {
  const claims: UidClaim[] = [];
  const paths: string[] = [];
  for await (const path of new Bun.Glob(OPS_GLOB).scan({ cwd: root, absolute: false })) {
    paths.push(path.replaceAll('\\', '/'));
  }
  for (const path of paths.sort()) {
    claims.push(...uidClaims(path, await Bun.file(`${root}/${path}`).text()));
  }
  const values = Bun.file(`${root}/${REPO_VALUES}`);
  const repo = (await values.exists()) ? repoChartUid(await values.text()) : undefined;
  return { claims, repo };
}

/**
 * The false green, refused: a chart with no `runAsUser`, or pages that attribute no uid to EITHER
 * image, would make "every stated uid is right" true of nothing.
 */
const unscannedFinding = (detail: string): Finding => ({
  code: 'X_DOC_UID_UNSCANNED',
  cause: `${detail}, so this rule reported green over uids it never compared`,
  fix: `bun run scripts/ops-uid-docs.ts --json — it reads ${OPS_GLOB} and ${REPO_VALUES}'s podSecurityContext.runAsUser`,
  at: REPO_VALUES,
});

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function opsUidFindings(root: string): Promise<readonly Finding[]> {
  const { claims, repo } = await readUidDocs(root);
  if (repo === undefined)
    return [unscannedFinding(`${REPO_VALUES} states no podSecurityContext.runAsUser`)];
  const owners = new Set(claims.map((claim) => claim.owner));
  if (!owners.has('repo') || !owners.has('scaffold')) {
    return [
      unscannedFinding(
        `${OPS_GLOB} attributes no uid to ${owners.has('repo') ? 'a scaffolded app' : "this repo's chart"}`,
      ),
    ];
  }
  return checkUidClaims(claims, { scaffold: RUNTIME_UID, repo });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const { claims } = await readUidDocs(root);
  const findings = await opsUidFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${claims.length} uid claim(s) in ${OPS_GLOB}, each the uid its image runs`
          : `${findings.length} uid claim(s) in ${OPS_GLOB} disagree with the tree`,
      findings,
      data: { claims },
    },
    args.json,
  );
}
