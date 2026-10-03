// Every action this repository runs is pinned by commit SHA with its version beside it, and no
// workflow splices an expression into shell source. Reads every REAL workflow and every local
// composite action — a tag is a pointer its owner can move, and `${{ }}` inside `run:` is text the
// runner pastes into a script before the shell parses it.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
}

interface Document {
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
  readonly runs?: { readonly steps?: readonly Step[] };
}

const root = repoRoot();
// `dot: true`: Bun's glob matches nothing under a dot-directory without it.
const files = [
  ...new Bun.Glob('.github/workflows/*.yml').scanSync({ cwd: root, dot: true }),
  ...new Bun.Glob('.github/actions/*/action.yml').scanSync({ cwd: root, dot: true }),
].sort();

const stepsOf = async (file: string): Promise<readonly { at: string; step: Step }[]> => {
  const text = await Bun.file(`${root}/${file}`).text();
  const doc = Bun.YAML.parse(text) as Document;
  const jobs = Object.entries(doc.jobs ?? {}).flatMap(([name, job]) =>
    (job.steps ?? []).map((step) => ({ at: `${file} · ${name}`, step })),
  );
  const composite = (doc.runs?.steps ?? []).map((step) => ({ at: file, step }));
  return [...jobs, ...composite];
};

const all = (await Promise.all(files.map(stepsOf))).flat();
/** The raw `uses:` lines, because the trailing `# vX.Y.Z` comment is gone once YAML is parsed. */
const usesLines = (
  await Promise.all(
    files.map(async (file) =>
      (
        await Bun.file(`${root}/${file}`).text()
      )
        .split('\n')
        .filter((line) => /^\s*-?\s*uses:/.test(line))
        .map((line) => ({ file, line: line.trim() })),
    ),
  )
).flat();

/**
 * `${{ runner.temp }}` is the one expression admitted in shell: the runner sets it, nothing a
 * contributor or an event controls reaches it, and `ci.yml`'s merge step must name the same path
 * its `download-artifact` step does (`ci-workflow-shape.test.ts`), which only an expression can.
 */
const TRUSTED_IN_SHELL = ['runner.temp'];
const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g;

describe('unit · every action, in every workflow and composite, is pinned by SHA', () => {
  test('the corpus is the real one: five workflows and the setup composite at least', () => {
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.github/workflows/release.yml');
    expect(files).toContain('.github/actions/setup/action.yml');
    expect(usesLines.length).toBeGreaterThan(10);
  });

  test('a remote action is `owner/repo@<40-hex sha> # v<version>`; a local one is a path', () => {
    const loose = usesLines.filter(
      ({ line }) =>
        !/uses: \.\/\.github\/actions\/[\w-]+$/.test(line) &&
        !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(line),
    );
    expect(loose).toEqual([]);
  });
});

describe('unit · no workflow splices an expression into shell', () => {
  test('every expression a `run:` needs arrives through `env:`', () => {
    const spliced = all.flatMap(({ at, step }) =>
      [...(step.run ?? '').matchAll(EXPRESSION)]
        .map((match) => match[1] ?? '')
        .filter((body) => !TRUSTED_IN_SHELL.includes(body))
        .map((body) => `${at} · ${step.name ?? '(unnamed)'}: ${body}`),
    );
    expect(spliced).toEqual([]);
  });
});
