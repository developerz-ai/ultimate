#!/usr/bin/env bun
// Bring `bun.lock`'s recorded `@ultimat3/*` ranges back into agreement with the `package.json`
// files it was generated from — the edit `X_LOCKFILE_STALE` names, performed.
//
// It exists because `bun install` will not do it. Bun refreshes a workspace block only when that
// workspace's own manifest changed, so a lockstep version bump leaves every untouched block
// recording the previous number, and `--frozen-lockfile` accepts all of them: a workspace edge
// resolves by NAME, so the range is never read back and never validated. 90 entries sat at 1.2.0
// and 2.0.0 against manifests that all said 3.0.0, and it recurred at 72 on 2026-08-22 — under a
// green run of THIS script, which read `packages/[a-z-]+` and so judged neither `i18n` nor any of
// the app workspaces that share the lockfile.
//
// Surgical on purpose. `rm bun.lock && bun install` also fixes the pins, and drags every EXTERNAL
// dependency to its newest matching release with it — measured on 2026-08-19, that moved Biome
// 2.5.5 -> 2.5.9 and `@types/node` 26.1.1 -> 26.2.0. A lockfile-hygiene change that silently bumps
// the linter is two changes wearing one commit.
//
//   bun run scripts/lockfile-pins.ts [--write] [--json]

import { dirname, relative } from 'node:path';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { workspaceManifests } from './lib/workspaces';
import { LOCK_BLOCK, LOCK_DEP, readInternalDeps } from './version-stamps';

interface LockedFact {
  /** The workspace DIRECTORY relative to the repo root — `bun.lock`'s own key for the block. */
  readonly dir: string;
  readonly locked: string;
  readonly declared: string;
}

/**
 * TWO stale facts per block, not one. `range` is the recorded `@ultimat3/*` dependency; `version`
 * is the workspace's OWN recorded version, which drifts by the same mechanism and was accepted by
 * `bun install --frozen-lockfile` at all 30 framework workspaces on 2026-08-22 — every one saying
 * 6.0.0 against a manifest saying 7.0.0. They are separate kinds because the causes read
 * differently and a reader has to be able to tell which fact moved.
 */
export type PinEdit =
  | ({ readonly kind: 'range'; readonly dep: string } & LockedFact)
  | ({ readonly kind: 'version' } & LockedFact);

/** The workspace's own recorded version. Non-global: it is the first `version` in the block. */
const LOCK_VERSION = /"version":\s*"([^"]+)"/;

export interface DeclaredFacts {
  /** `@ultimat3/*` ranges per workspace directory. */
  readonly deps: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Each workspace directory's own declared version. */
  readonly versions: Readonly<Record<string, string>>;
}

/**
 * Rewrite every recorded fact to what that workspace's own manifest declares, and report what
 * moved. The manifest is the authority in one direction only — this never edits a `package.json`,
 * because a lockfile disagreeing with a manifest is the lockfile being stale, not the manifest.
 *
 * Every workspace, not `packages/*`: the two tracked apps and their nested workspaces resolve the
 * same `@ultimat3/*` pins out of this file, and 53 of the 72 ranges found stale on 2026-08-22 were
 * in one of them. The block pattern is imported rather than restated for the same reason the
 * vocabulary rule exists — two regexes over one file format is two answers to one question.
 */
export function correctLockfile(
  lock: string,
  declared: DeclaredFacts,
): { readonly text: string; readonly edits: readonly PinEdit[] } {
  const edits: PinEdit[] = [];
  const text = lock.replace(LOCK_BLOCK, (whole, dir: string, body: string) => {
    const wantDeps = declared.deps[dir];
    const wantVersion = declared.versions[dir];
    if (wantDeps === undefined && wantVersion === undefined) return whole;
    let fixed = body.replace(LOCK_DEP, (line, dep: string, locked: string) => {
      const target = wantDeps?.[dep];
      if (target === undefined || target === locked) return line;
      edits.push({ kind: 'range', dir, dep, locked, declared: target });
      return `"${dep}": "${target}"`;
    });
    fixed = fixed.replace(LOCK_VERSION, (line, locked: string) => {
      if (wantVersion === undefined || wantVersion === locked) return line;
      edits.push({ kind: 'version', dir, locked, declared: wantVersion });
      return `"version": "${wantVersion}"`;
    });
    return `    "${dir}": {${fixed}\n    },`;
  });
  return { text, edits };
}

const causeOf = (edit: PinEdit): string =>
  edit.kind === 'range'
    ? `bun.lock records ${edit.dir} depending on ${edit.dep}@${edit.locked}, and that package.json says ${edit.declared}`
    : `bun.lock records ${edit.dir} at version ${edit.locked}, and that package.json says ${edit.declared}`;

const findingFor = (edit: PinEdit): Finding => ({
  code: 'X_LOCKFILE_STALE',
  at: 'bun.lock',
  cause: causeOf(edit),
  fix: 'bun run scripts/lockfile-pins.ts --write, then bun install --frozen-lockfile to confirm',
});

/** Every workspace's declared version, keyed the way `bun.lock` keys its blocks. */
export async function readDeclaredVersions(
  root: string,
): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {};
  for (const path of await workspaceManifests(root)) {
    const json = (await Bun.file(path).json()) as { version?: string };
    if (json.version !== undefined) out[relative(root, dirname(path))] = json.version;
  }
  return out;
}

export const declaredFacts = async (root: string): Promise<DeclaredFacts> => ({
  deps: await readInternalDeps(root),
  versions: await readDeclaredVersions(root),
});

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const json = flagBool(args, 'json');
  const write = flagBool(args, 'write');
  const root = repoRoot();
  const lock = Bun.file(`${root}/bun.lock`);
  const { text, edits } = correctLockfile(await lock.text(), await declaredFacts(root));
  if (write && edits.length > 0) await Bun.write(`${root}/bun.lock`, text);
  const ok = write || edits.length === 0;
  report(
    {
      ok,
      script: 'lockfile-pins',
      summary:
        edits.length === 0
          ? 'bun.lock agrees with every package.json it was generated from'
          : write
            ? `corrected ${edits.length} recorded fact(s) — run bun install --frozen-lockfile to confirm`
            : `${edits.length} recorded fact(s) disagree with their package.json`,
      findings: write ? [] : edits.map(findingFor),
    },
    json,
  );
}
