// The `native-confirm` guard as `x new` emits it, run through the gate's own seam: a `confirm(` in
// an island or under `apps/web/` is refused at its line; a comment, a `// why:` and a test are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const ISLAND = 'apps/web/app/posts/delete.island.tsx';

describe('unit · shipped guard · native-confirm', () => {
  test('a planted confirm( is X_NATIVE_CONFIRM at its line, and the fix names ConfirmDialog', async () => {
    const findings = await shippedGuardFindings('native-confirm', {
      [ISLAND]: [
        'export const mount = () => {',
        "  if (confirm('Delete?')) remove();",
        "  if (window.confirm('Really?')) remove();",
        '};',
        '',
      ].join('\n'),
      'apps/web/app/posts/page.tsx': "export const ask = () => globalThis.confirm('Delete?');\n",
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_NATIVE_CONFIRM', `${ISLAND}:2`],
      ['X_NATIVE_CONFIRM', `${ISLAND}:3`],
      ['X_NATIVE_CONFIRM', 'apps/web/app/posts/page.tsx:1'],
    ]);
    expect(findings[0]?.fix).toContain("<ConfirmDialog> from '@ultimat3/ui'");
  });

  test('a comment, a why:, a method, a test and a file outside apps/web are silent', async () => {
    const call = "confirm('Delete?');\n";
    const findings = await shippedGuardFindings('native-confirm', {
      [ISLAND]: [
        "// confirm('Delete?') is what this replaced",
        "confirm('Leave?'); // why: an unload prompt, not a destructive act",
        'dialog.confirm(input);',
        '',
      ].join('\n'),
      'apps/web/app/posts/delete.island.test.tsx': call,
      'packages/domain/src/rules.ts': call,
    });
    expect(findings).toEqual([]);
  });

  test('a confirm the file binds itself is its own; a bare global or window.confirm( is not', async () => {
    const findings = await shippedGuardFindings('native-confirm', {
      'apps/web/app/a.ts': 'const confirm = async () => {};\nvoid confirm();\n',
      'apps/web/app/b.ts': 'export function ask(confirm) {\n  return confirm();\n}\n',
      'apps/web/app/c.tsx':
        'export const Ask = ({ confirm }: Props) => <b onClick={() => confirm()} />;\n',
      'apps/web/app/d.ts': "import { confirm } from './x';\nconfirm('Delete?');\n",
      'apps/web/app/e.ts':
        "let confirm;\nconfirm = make();\nconfirm('x');\nwindow.confirm('Really?');\n",
      'apps/web/app/f.ts': "const { confirm: ask } = deps;\nask();\nconfirm('x');\n",
      'apps/web/app/g.ts': "import { confirm as ask } from './x';\nif (confirm('x')) ask();\n",
      'apps/web/app/h.ts': 'export const run = confirm => confirm();\n',
      'apps/web/app/i.ts': "export function ask(ok = confirm('Sure?')) {\n  return ok;\n}\n",
    });
    expect(findings.map((finding) => finding.at)).toEqual([
      'apps/web/app/e.ts:4',
      'apps/web/app/f.ts:3',
      'apps/web/app/g.ts:2',
      'apps/web/app/i.ts:1',
    ]);
  });
});
