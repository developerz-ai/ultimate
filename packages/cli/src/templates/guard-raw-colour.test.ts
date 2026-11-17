// The `raw-colour` guard as the gate runs it, over a component's inline `style`: a colour typed
// into a TSX attribute is the same raw colour as one typed into a stylesheet, and it used to pass.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const at = (findings: readonly { readonly at?: string }[]) => findings.map((finding) => finding.at);

describe('unit · shipped guard · raw-colour · inline style', () => {
  test('a style object, a style string and a string expression are each refused', async () => {
    const findings = await shippedGuardFindings('raw-colour', {
      'apps/web/site/a.tsx':
        "export const A = () => <span style={{ color: '#ff0000' }}>x</span>;\n",
      'apps/web/app/b.tsx': 'export const B = () => <p style="background: red">x</p>;\n',
      'apps/web/shared/c.tsx': "export const C = () => <i style={'border-color: rgb(1 2 3)'} />;\n",
      'packages/ui/src/d.tsx':
        "export const D = () => (\n  <b\n    style={{ padding: 0, 'background-color': 'hsl(1 2% 3%)' }}\n  />\n);\n",
    });
    expect(at(findings).sort()).toEqual([
      'apps/web/app/b.tsx',
      'apps/web/shared/c.tsx',
      'apps/web/site/a.tsx',
      'packages/ui/src/d.tsx',
    ]);
    const first = findings.find((finding) => finding.at === 'apps/web/site/a.tsx');
    expect(first?.code).toBe('X_RAW_COLOUR');
    expect(first?.cause).toContain('apps/web/site/a.tsx:1');
    expect(first?.cause).toContain('#ff0000');
    expect(first?.fix).toContain('rgb(var(--color-');
    // The line of the attribute, not of the element: the object spans lines.
    const spread = findings.find((finding) => finding.at === 'packages/ui/src/d.tsx');
    expect(spread?.cause).toContain('packages/ui/src/d.tsx:3');
    expect(spread?.cause).toContain('hsl(1 2% 3%)');
  });

  // The lookalikes: a token reference, a value that is not a colour, a style held in a variable,
  // and a test file, which renders to nobody.
  test('a token, a non-colour value, a computed style and a test file are not reported', async () => {
    const findings = await shippedGuardFindings('raw-colour', {
      'apps/web/site/a.tsx':
        "export const A = () => <span style={{ color: 'rgb(var(--color-fg))', display: 'block' }} />;\n",
      'apps/web/site/b.tsx': 'export const B = (p: { s: string }) => <span style={p.s} />;\n',
      'apps/web/site/c.tsx': `export const C = () => <span style={{ '--x': \`\${1}px\` }} />;\n`,
      'apps/web/site/d.test.tsx': "export const D = () => <span style={{ color: '#ff0000' }} />;\n",
      'apps/web/site/e.tsx': "// <span style={{ color: '#ff0000' }} />\nexport const E = 1;\n",
    });
    expect(findings).toEqual([]);
  });

  test('a stylesheet is still judged as before', async () => {
    const findings = await shippedGuardFindings('raw-colour', {
      'apps/web/site/a.module.scss': '.a {\n  color: #ff0000;\n}\n',
    });
    expect(at(findings)).toEqual(['apps/web/site/a.module.scss']);
    expect(findings[0]?.fix).toContain("tokens.role('fg')");
  });
});
