// `finished-repo.ts`: the no-stub row over fixture sources and a fixture Known-Gaps page, and the
// no-planned-command row over fixture registries.

import { describe, expect, test } from 'bun:test';
import { plannedRow, stubRow } from './finished-repo';

const STUB =
  "export const f = () => {\n  throw new NotImplementedError({ cause: 'c', fix: 'x' });\n};\n";
const GAPS = '## Open by decision\n\n| Gap | Why it stays |\n|---|---|\n';

describe('finished · no-stub', () => {
  test('a shipped NotImplementedError no row names is red, at its file and line', () => {
    const row = stubRow([{ at: 'packages/a/src/a.ts', text: STUB }], GAPS);
    expect(row.verdict).toBe('red');
    expect(row.findings.map((one) => [one.code, one.at])).toEqual([
      ['X_FINISHED_STUB', 'packages/a/src/a.ts:2'],
    ]);
    expect(row.findings[0]?.fix).toStartWith('edit packages/a/src/a.ts:2 — ');
  });

  test('a call to the notImplemented() helper is a stub too', () => {
    const text = "export const g = () => notImplemented('streams', 'x dev');\n";
    expect(stubRow([{ at: 'packages/a/src/g.ts', text }], GAPS).verdict).toBe('red');
  });

  test('a test, a fixture, core’s own definition and a comment are not shipped stubs', () => {
    const files = [
      { at: 'packages/a/src/a.test.ts', text: STUB },
      { at: 'packages/a/src/boot-fixture.ts', text: STUB },
      { at: 'packages/core/src/errors.ts', text: STUB },
      { at: 'packages/a/src/c.ts', text: '// new NotImplementedError( once lived here\n' },
      { at: 'packages/a/src/d.ts', text: 'export function notImplemented(a: string) {}\n' },
    ];
    expect(stubRow(files, GAPS).verdict).toBe('green');
  });

  test('a stub whose file a Known-Gaps row names is a decided gap', () => {
    const page = `${GAPS}| the a stub | packages/a/src/a.ts stays: no driver can |\n`;
    expect(stubRow([{ at: 'packages/a/src/a.ts', text: STUB }], page).verdict).toBe('green');
  });
});

describe('finished · no-planned-command', () => {
  test('empty registries are green', () => {
    expect(plannedRow({ commands: [], subcommands: [], source: '' }).verdict).toBe('green');
  });

  test('each planned command and subcommand is red, opened at its registry line', () => {
    const source =
      "const A = [\n  {\n    name: 'branch',\n  },\n];\nconst B = [{ command: 'db', subcommand: 'studio' }];\n";
    const row = plannedRow({ commands: ['branch'], subcommands: ['db studio'], source });
    expect(row.verdict).toBe('red');
    expect(row.findings.map((one) => one.at)).toEqual([
      'packages/cli/src/cmd-planned.ts:3',
      'packages/cli/src/cmd-planned.ts:6',
    ]);
    expect(row.findings.every((one) => one.code === 'X_FINISHED_PLANNED_COMMAND')).toBe(true);
  });
});
