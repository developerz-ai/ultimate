// Every workflow `x new` writes runs other people's code before the app's own: each `uses:` is a
// commit SHA no tag owner can move, and no checkout leaves the job token on disk for the
// `bun install` after it to read (zizmor's `unpinned-uses` and `artipacked`, rendered and asked).

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { names } from '../naming';
import { githubFiles } from './ci.yml';

const ROOT = `${import.meta.dir}/../../../../..`;

interface Step {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}
interface Workflow {
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const workflows = githubFiles(names('ledger-demo')).flatMap((file) =>
  file.path.startsWith('.github/workflows/') && typeof file.contents === 'string'
    ? [{ path: file.path, text: file.contents }]
    : [],
);

/** Each raw `uses:` line, its comment kept: YAML drops the `# vN` the pin is read by. */
const usesLines = (text: string): readonly string[] =>
  text.split('\n').flatMap((line) => /^\s*- uses: (.+)$/.exec(line)?.[1] ?? []);

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+){0,2}$/;

describe('unit · the actions the emitted workflows run', () => {
  test('the scaffold writes workflows, and each runs at least one action', () => {
    expect(workflows.map((file) => file.path).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/image.yml',
    ]);
    for (const file of workflows) expect(usesLines(file.text).length).toBeGreaterThan(0);
  });

  test('every uses: is pinned to a 40-hex commit SHA, its version in the trailing comment', () => {
    const loose = workflows.flatMap((file) =>
      usesLines(file.text)
        .filter((uses) => !PINNED.test(uses))
        .map((uses) => `${file.path}: ${uses}`),
    );
    expect(loose).toEqual([]);
  });

  test('every checkout drops the job token: persist-credentials is false', () => {
    const checkouts = workflows.flatMap((file) =>
      Object.values((YAML.parse(file.text) as Workflow).jobs ?? {}).flatMap((job) =>
        (job.steps ?? [])
          .filter((step) => step.uses?.startsWith('actions/checkout@') === true)
          .map((step) => ({ path: file.path, persist: step.with?.['persist-credentials'] })),
      ),
    );
    expect(checkouts.length).toBe(4);
    for (const checkout of checkouts) expect(checkout).toEqual({ ...checkout, persist: false });
  });

  // The framework's own workflows are the pins it already reviewed and Dependabot moves: a pin
  // here that no workflow of the framework runs is one nobody looked at.
  test('each pin is one the framework’s own workflows run, SHA and version alike', async () => {
    const own = new Set<string>();
    for (const pattern of ['.github/workflows/*.yml', '.github/actions/*/action.yml']) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT })) {
        for (const uses of usesLines(await Bun.file(`${ROOT}/${path}`).text())) own.add(uses);
      }
    }
    const foreign = workflows
      .flatMap((file) => usesLines(file.text))
      .filter((uses) => !own.has(uses));
    expect(foreign).toEqual([]);
  });
});
