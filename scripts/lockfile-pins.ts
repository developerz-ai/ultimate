#!/usr/bin/env bun
// Bring `bun.lock`'s recorded `@ultimat3/*` ranges back into agreement with the `package.json`
// files it was generated from — the edit `X_LOCKFILE_STALE` names, performed.
//
// It exists because `bun install` will not do it. Bun refreshes a workspace block only when that
// workspace's own manifest changed, so a lockstep version bump leaves every untouched block
// recording the previous number, and `--frozen-lockfile` accepts all of them: a workspace edge
// resolves by NAME, so the range is never read back and never validated. 90 entries sat at 1.2.0
// and 2.0.0 against manifests that all said 3.0.0.
//
// Surgical on purpose. `rm bun.lock && bun install` also fixes the pins, and drags every EXTERNAL
// dependency to its newest matching release with it — measured on 2026-08-19, that moved Biome
// 2.5.5 -> 2.5.9 and `@types/node` 26.1.1 -> 26.2.0. A lockfile-hygiene change that silently bumps
// the linter is two changes wearing one commit.
//
//   bun run scripts/lockfile-pins.ts [--write] [--json]

import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { readInternalDeps } from './version-stamps';

export interface PinEdit {
  readonly pkg: string;
  readonly dep: string;
  readonly locked: string;
  readonly declared: string;
}

const BLOCK = /"packages\/([a-z-]+)":\s*\{(.*?)\n {4}\},/gs;
const DEP = /"(@ultimat3\/[a-z-]+)":\s*"([^"]+)"/g;

/**
 * Rewrite every recorded range to what that package's own manifest declares, and report what
 * moved. The manifest is the authority in one direction only — this never edits a `package.json`,
 * because a lockfile disagreeing with a manifest is the lockfile being stale, not the manifest.
 */
export function correctLockfile(
  lock: string,
  declared: Readonly<Record<string, Readonly<Record<string, string>>>>,
): { readonly text: string; readonly edits: readonly PinEdit[] } {
  const edits: PinEdit[] = [];
  const text = lock.replace(BLOCK, (whole, dir: string, body: string) => {
    const want = declared[dir];
    if (want === undefined) return whole;
    const fixed = body.replace(DEP, (line, dep: string, locked: string) => {
      const target = want[dep];
      if (target === undefined || target === locked) return line;
      edits.push({ pkg: dir, dep, locked, declared: target });
      return `"${dep}": "${target}"`;
    });
    return `"packages/${dir}": {${fixed}\n    },`;
  });
  return { text, edits };
}

const findingFor = (edit: PinEdit): Finding => ({
  code: 'X_LOCKFILE_STALE',
  at: 'bun.lock',
  cause: `bun.lock records packages/${edit.pkg} depending on ${edit.dep}@${edit.locked}, and that package.json says ${edit.declared}`,
  fix: 'bun run scripts/lockfile-pins.ts --write, then bun install --frozen-lockfile to confirm',
});

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const json = flagBool(args, 'json');
  const write = flagBool(args, 'write');
  const root = repoRoot();
  const lock = Bun.file(`${root}/bun.lock`);
  const { text, edits } = correctLockfile(await lock.text(), await readInternalDeps(root));
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
            ? `corrected ${edits.length} recorded range(s) — run bun install --frozen-lockfile to confirm`
            : `${edits.length} recorded range(s) disagree with their package.json`,
      findings: write ? [] : edits.map(findingFor),
    },
    json,
  );
}
