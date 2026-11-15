// Carries an older app's Bun pins to the ones `x new` writes now: every Dockerfile's `FROM oven/bun:`
// onto the scaffold's digest, every workflow's `setup-bun` onto its commit pin and `bun-version:`
// onto the CLI's floor, and `engines.bun` / `.bun-version` / `packageManager` up to that floor.
// A file holding a pin the app chose itself is left whole, reported with the diff it would take.

import { REQUIRED_BUN } from '../app-root';
import { SCAFFOLD_BUN_IMAGE } from '../templates/bun-image';
import { editBunSites } from '../upgrade-bun-floor';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import { mergeResults, readText } from './engine-edits';
import { dockerfileLine, type LineVerdict, recordedLine, workflowLine } from './runtime-pin-lines';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

const DOCKERFILES = [
  'Dockerfile*',
  '*.Dockerfile',
  'docker/**/Dockerfile*',
  'docker/**/*.Dockerfile',
];
const WORKFLOWS = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.github/actions/**/action.yml',
  '.github/actions/**/action.yaml',
];
const MANIFESTS = ['package.json', '.bun-version'];

/** Every path the patterns match, once, in order: two globs can name one file. */
async function pathsOf(app: CodemodApp, patterns: readonly string[]): Promise<readonly string[]> {
  const found = await Promise.all(patterns.map((pattern) => app.glob(pattern)));
  return [...new Set(found.flat())].filter((path) => !path.endsWith('.dockerignore')).sort();
}

/** One file, line by line: written when every pin in it is the scaffold's to move, else reported. */
async function migrateLines(
  app: CodemodApp,
  path: string,
  judge: (line: string) => LineVerdict,
  carried: (lines: readonly string[]) => readonly string[] = (lines) => lines,
): Promise<CodemodResult> {
  // LF lines with no BOM: a CRLF line's `\r` would defeat each `$`-anchored pin pattern.
  const file = await readText(app, path);
  if (file === undefined) return NOTHING;
  const source = file.text;
  const lines = source.split('\n');
  const verdicts = lines.map(judge);
  const foreign: string[] = [];
  const next = verdicts.map((verdict, index) => {
    if (verdict.kind === 'keep') return lines[index] ?? '';
    if (verdict.kind === 'foreign') foreign.push(`${path}:${String(index + 1)}: ${verdict.why}`);
    return verdict.to;
  });
  const moved = verdicts.some((verdict) => verdict.kind !== 'keep');
  const text = (moved ? carried(next) : next).join('\n');
  if (foreign.length > 0) {
    const diff = unifiedDiff(path, source, text);
    const reason = `a Bun pin here is the app's own, so the file is left as it is — ${foreign.join('; ')}`;
    return { changed: [], skipped: [{ path, reason, ...(diff === '' ? {} : { diff }) }] };
  }
  if (text === source) return NOTHING;
  await app.write(path, file.restore(text));
  return { changed: [path], skipped: [] };
}

/** `engines.bun`, `packageManager` and `.bun-version`, raised by the one floor editor `x upgrade` has. */
async function migrateManifest(app: CodemodApp, path: string): Promise<CodemodResult> {
  const source = await app.read(path);
  if (source === undefined) return NOTHING;
  const { text, manual } = editBunSites(path, source, REQUIRED_BUN);
  if (manual.length > 0) {
    const why = manual.map((site) => `${site.path}:${String(site.line)}: ${site.why}`).join('; ');
    const diff = unifiedDiff(path, source, text);
    return {
      changed: [],
      skipped: [
        {
          path,
          reason: `a Bun pin here is the app's own — ${why}`,
          ...(diff === '' ? {} : { diff }),
        },
      ],
    };
  }
  if (text === source) return NOTHING;
  await app.write(path, text);
  return { changed: [path], skipped: [] };
}

export const codemod: Codemod = {
  id: 'runtime-pin',
  // The release that ships this codemod. Its rewrite targets the pin 29.0.0's scaffold first wrote,
  // but a codemod runs only for a hop whose span holds `since` (or a rerun at the target), so a
  // `since` of 29.0.0 would never reach an app already past it — every app this codemod is for.
  since: '31.28.0',
  summary: `every Bun pin onto the one x new writes: ${SCAFFOLD_BUN_IMAGE.ref}, bun-version ${REQUIRED_BUN}`,
  async run(app) {
    const results: CodemodResult[] = [];
    for (const path of await pathsOf(app, DOCKERFILES)) {
      results.push(
        await migrateLines(
          app,
          path,
          (line) => dockerfileLine(line, SCAFFOLD_BUN_IMAGE),
          (lines) => lines.map((line) => recordedLine(line, SCAFFOLD_BUN_IMAGE)),
        ),
      );
    }
    for (const path of await pathsOf(app, WORKFLOWS))
      results.push(await migrateLines(app, path, workflowLine));
    for (const path of await pathsOf(app, MANIFESTS))
      results.push(await migrateManifest(app, path));
    return mergeResults(results);
  },
};
