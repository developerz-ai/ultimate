// The brain a generated app is born with, held to one thing: it must name the gate the app
// actually has. `AGENTS.md`, `CLAUDE.md` and `.claude/commands/verify.md` all said `x verify`,
// which is HALF of `bin/check` — the build comes first and is what writes the
// `.x/build-stats.json` the `budgets` step measures, so an agent that followed the brain ran the
// gate, watched `budgets` go red with X_BUDGET_UNMEASURED, and started debugging its own code.
// A brain that names the wrong command is worse than one that names none: it is confidently wrong.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { claudeCommandFiles } from './scaffold-claude-commands';
import { docsFiles } from './scaffold-docs';

const app = names('ledger-demo');

const emitted = (
  files: readonly { path: string; contents: string | Uint8Array }[],
  path: string,
) => {
  const found = files.find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const doc = (path: string): string => emitted(docsFiles(app), path);

describe('unit · the generated brain names bin/check as the gate', () => {
  // One row, and it is the row an agent reads first. Matched on the row rather than on the file,
  // so a `bin/check` mentioned three paragraphs down cannot make this pass.
  test("AGENTS.md's gate row is bin/check, and it says what the first half is", () => {
    const rows = doc('AGENTS.md')
      .split('\n')
      .filter((line) => line.startsWith('| One gate |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('bin/check');
    // The build is the half `x verify` does not do. Named, or the row is just a different word
    // for the same misunderstanding.
    expect(doc('AGENTS.md')).toContain('X_BUDGET_UNMEASURED');
  });

  test("CLAUDE.md's Gate bullet is bin/check, and points at the CI that runs it", () => {
    const bullet = doc('CLAUDE.md')
      .split('\n')
      .find((line) => line.startsWith('- Gate:'));
    expect(bullet).toContain('bin/check');
    expect(doc('CLAUDE.md')).toContain('.github/workflows/ci.yml');
  });

  test('/verify runs bin/check — the command whose whole job is the gate', () => {
    const verify = emitted(claudeCommandFiles(app), '.claude/commands/verify.md');
    const instruction = verify.split('\n').find((line) => line.startsWith('Run '));
    expect(instruction).toContain('bin/check');
    expect(instruction).not.toContain('x verify');
  });

  test('/feature reports the same gate it tells the agent to run', () => {
    const feature = emitted(claudeCommandFiles(app), '.claude/commands/feature.md');
    expect(feature).toContain('**Done means `bin/check` green.**');
    expect(feature).toContain('Gate:       bin/check');
  });

  // The README is the human's copy of the same fact, and it is the file `bin/check` is documented
  // in. A build that is not mentioned there is a build nobody knows the gate depends on.
  test('README.md describes bin/check as a build and then the checks', () => {
    const line = doc('README.md')
      .split('\n')
      .find((text) => text.startsWith('bin/check'));
    expect(line).toContain('build');
  });
});

describe('unit · the generated brain states that .dz/ is additive', () => {
  // The developerz.ai platform moves a repo's config under `.dz/` (`.dz/maintainer/maintainer.yml`,
  // `.dz/pipeline/agent-pipeline.json`). Nothing `x new` writes lands there and nothing here is
  // generated from it — but an agent with no statement either way has to guess, and the two guesses
  // are "delete the platform's file" and "do not touch AGENTS.md".
  test('AGENTS.md names the directory, both owners, and that neither clobbers the other', () => {
    const text = doc('AGENTS.md');
    expect(text).toContain('.dz/maintainer/');
    expect(text).toContain('ADDITIVE');
    expect(text).toContain('clobber');
  });

  test('CLAUDE.md says it too, since it is the file a Claude session reads first', () => {
    const text = doc('CLAUDE.md');
    expect(text).toContain('.dz/');
    expect(text).toContain('clobber');
  });
});
