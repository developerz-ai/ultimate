#!/usr/bin/env bun
// Hold CHANGELOG.md to being the index: every `## X.Y.Z` section it still carries moves, byte for
// byte, to `docs/changelog/X.Y.Z.md`, and its `## Releases` table is rewritten from those files.
// Without `--write` it only reports — the same findings `changelog-check` folds into the gate.
//
//   bun run scripts/changelog-index.ts [--write] [--json]

import { flagBool, parseScriptArgs } from './lib/args';
import { CHANGELOG_PATH } from './lib/changelog-format';
import { indexFindings, moveReleasedSections, withReleaseTable } from './lib/changelog-index';
import { assembleChangelog, readChangelogFiles } from './lib/changelog-store';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'changelog-index';

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const read = await readChangelogFiles(root);
  if (flagBool(args, 'write')) {
    const move = moveReleasedSections(read.index, read.files);
    const files = [...read.files, ...move.moved];
    const index = withReleaseTable(move.index, assembleChangelog(move.index, files));
    // Release files first: an index row never links a file that is not there yet.
    for (const file of move.moved) await Bun.write(`${root}/${file.path}`, file.text);
    if (index !== read.index) await Bun.write(`${root}/${CHANGELOG_PATH}`, index);
    const findings = [...move.findings, ...indexFindings(index, files)];
    report(
      {
        ok: findings.length === 0,
        script: SCRIPT,
        summary: `${move.moved.length} section(s) moved to docs/changelog/, ${CHANGELOG_PATH} ${index === read.index ? 'unchanged' : 'rewritten'}`,
        findings,
        data: { moved: move.moved.map((file) => file.path), indexWritten: index !== read.index },
      },
      args.json,
    );
  }
  const findings = indexFindings(read.index, read.files);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${CHANGELOG_PATH} indexes ${read.files.length} release file(s) in docs/changelog/`
          : `${findings.length} finding(s): ${CHANGELOG_PATH} and docs/changelog/ disagree`,
      findings,
    },
    args.json,
  );
}
