// The sentences of the rendered kit that carry a safety rule, pinned as the app reads them: the
// audit agent never runs the branch's tests, `feature` ends at a merge gate nobody bypasses, and
// `planx` points its acceptance line at that gate. Whitespace is collapsed: the files wrap at 100
// columns and a rule must not move with a reflow.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import { kitFiles } from './registry';

const app = names('ledger-demo');
const textOf = (path: string): string => {
  const file = kitFiles(app).find((entry) => entry.path === path);
  expect(file).toBeDefined();
  return (file?.contents ?? '').replace(/\s+/g, ' ');
};

describe('unit · the audit agent runs nothing of the branch under review', () => {
  const path = '.claude/agents/audit.md';

  test('it is told never to run `bun test`, and why', () => {
    const text = textOf(path);
    expect(text).toContain('Never `bun test`');
    expect(text).toContain("a test on the branch under review is that branch's code");
  });

  test('no line anywhere recommends `bun test ./`', () => {
    const file = kitFiles(app).find((entry) => entry.path === path);
    const offenders = (file?.contents ?? '')
      .split('\n')
      .filter((line) => /bun test \.\//.test(line));
    expect(offenders).toEqual([]);
  });

  test('its evidence is static, and a proposed test goes to the coordinator, not to a run', () => {
    const text = textOf(path);
    expect(text).toContain('Your evidence is static');
    expect(text).toContain('A failing test you propose goes in the report');
    expect(text).toContain('only in a disposable checkout with no credentials');
  });
});

describe('unit · feature ends at a merge gate nobody bypasses', () => {
  const text = textOf('.claude/skills/feature/SKILL.md');

  test('every required check on the head passed, the required review included', () => {
    expect(text).toContain('every required check on the head commit has passed');
    expect(text).toContain('the required review included');
  });

  test('every thread is resolved', () => {
    expect(text).toContain('every thread is resolved');
  });

  test('the merge is a squash, and the forge refusing it is the answer, never --admin', () => {
    expect(text).toContain('`gh pr merge --squash`');
    expect(text).toContain('that refusal is the answer, never `--admin`');
  });
});

describe('unit · planx points its acceptance line at that gate', () => {
  test("the one PR merges through feature's merge gate, review and threads named", () => {
    const text = textOf('.claude/skills/planx/SKILL.md');
    expect(text).toContain("through `feature`'s merge gate");
    expect(text).toContain('every required check on its head passed, the review included');
    expect(text).toContain('every thread resolved');
  });
});
